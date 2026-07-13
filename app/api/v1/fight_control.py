from sqlalchemy import func, cast, Numeric
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from app.core.database import get_db
from app.api.auth_deps import require_admin
from app.models.user import User
from app.models.bet import Bet, BetTypeEnum, BetStatusEnum
from app.services.fight_state_service import FightStateService, FightPhase

router = APIRouter(prefix="/admin", tags=["Fight Control"])


@router.post("/round/new")
async def create_new_round(admin: User = Depends(require_admin)):
    """
    Explicitly starts a new cockfight round/queue. This is now a deliberate,
    separate action instead of an automatic side effect of opening betting -
    only allowed while the system is idle (CLOSED) and no round is already
    waiting to be opened.
    """
    new_round = FightStateService.create_new_round()
    return {
        "status": f"Round #{new_round} created. Open betting when ready.",
        "fight_round": new_round,
        "current_phase": FightStateService.get_phase(),
    }


@router.post("/phase/{phase_name}")
async def set_system_phase(phase_name: FightPhase, admin: User = Depends(require_admin)):
    """Advances the system one legal step at a time: BETTING -> COCKFIGHT -> REDEEMING -> CLOSED.

    Each call is checked against the allowed transition table, so this can
    no longer jump straight from REDEEMING into COCKFIGHT (or any other
    out-of-sequence combination) on a mis-click or mis-typed phase name.
    Opening BETTING requires that a round was created first via
    POST /admin/round/new.
    """
    FightStateService.set_phase(phase_name)
    return {
        "status": "success",
        "current_phase": FightStateService.get_phase(),
        "fight_round": FightStateService.get_round(),
    }


@router.post("/system/reset")
async def reset_system(admin: User = Depends(require_admin)):
    """
    Full reset of the live fight-state machine (phase + round counter) back
    to a brand new idle system, for wrapping up after all rounds are
    finished, or recovering cleanly after a misinput/incident - so the
    system is ready for a future cockfight event starting at round #0
    again. Only allowed while CLOSED; does not touch any stored ticket or
    audit-log records.
    """
    FightStateService.full_system_reset()
    return {
        "status": "System fully reset. Ready for a new cockfight event.",
        "current_phase": FightStateService.get_phase(),
        "fight_round": FightStateService.get_round(),
    }


@router.post("/fight-result")
async def declare_fight_result(winning_bet_type: BetTypeEnum, db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)):
    """Resolves fight outcomes once fight ends. Enforces strict transactional updates and calculates Pari-Mutuel payouts.

    Scoped strictly to the CURRENT fight round and to still-PENDING bets, so:
      1. Bets from previous/future fight queues are never mixed into this pool.
      2. If this endpoint is ever called twice for the same round (e.g. admin
         flips phase back to COCKFIGHT by mistake), already-resolved tickets
         (WON/LOST) are left untouched instead of having their payout figures
         silently overwritten.
    """
    FightStateService.enforce_phase(FightPhase.COCKFIGHT)
    current_round = FightStateService.get_round()

    # Tellers can only sell MERON/WALA tickets, but a fight can still end in
    # a no-decision/draw. There is no "winning side" to pool against in that
    # case, so every still-pending ticket for this round gets refunded in
    # full instead of being run through the win/loss pari-mutuel split.
    if winning_bet_type == BetTypeEnum.DRAW:
        pending_stmt = select(func.sum(Bet.net_amount)).where(
            Bet.fight_round == current_round,
            Bet.status == BetStatusEnum.PENDING,
        )
        pending_result = await db.execute(pending_stmt)
        total_pending = pending_result.scalar() or 0.0

        if total_pending <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"No pending bets found for fight round {current_round}. Nothing to resolve.",
            )

        await db.execute(
            Bet.__table__.update()
            .where(
                Bet.fight_round == current_round,
                Bet.status == BetStatusEnum.PENDING,
            )
            .values(status=BetStatusEnum.REFUNDED, payout_ratio=1.0, payout_amount=Bet.net_amount)
        )
        await db.commit()

        FightStateService.set_phase(FightPhase.REDEEMING)
        return {
            "status": f"Fight round {current_round} declared NO DECISION. All pending tickets refunded in full.",
            "fight_round": current_round,
            "total_net_pool": round(total_pending, 2),
            "winning_net_pool": 0.0,
            "payout_ratio": 1.0,
            "outcome": "REFUND",
        }

    # 1. Calculate Total Net Pool across still-pending bets in THIS round only
    total_net_pool_stmt = select(func.sum(Bet.net_amount)).where(
        Bet.fight_round == current_round,
        Bet.status == BetStatusEnum.PENDING,
    )
    total_net_result = await db.execute(total_net_pool_stmt)
    total_net_pool = total_net_result.scalar() or 0.0

    if total_net_pool <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"No pending bets found for fight round {current_round}. Nothing to resolve.",
        )

    # 2. Calculate Total Net Amount staked on the winning side, this round only
    winning_net_stmt = select(func.sum(Bet.net_amount)).where(
        Bet.fight_round == current_round,
        Bet.status == BetStatusEnum.PENDING,
        Bet.bet_type == winning_bet_type,
    )
    winning_net_result = await db.execute(winning_net_stmt)
    winning_net_pool = winning_net_result.scalar() or 0.0

    # 3. Calculate Payout Ratio (R = Total Net Pool / Winning Side Net Pool)
    payout_ratio = round(total_net_pool / winning_net_pool, 4) if winning_net_pool > 0 else 0.0

    # 4. Update winners atomically, scoped to this round and still-pending only
    await db.execute(
        Bet.__table__.update()
        .where(
            Bet.fight_round == current_round,
            Bet.status == BetStatusEnum.PENDING,
            Bet.bet_type == winning_bet_type,
        )
        .values(
            status=BetStatusEnum.WON,
            payout_ratio=payout_ratio,
            payout_amount=func.round(cast(Bet.net_amount * payout_ratio, Numeric), 2),
        )
    )
    # 5. Update losers atomically, scoped to this round and still-pending only
    await db.execute(
        Bet.__table__.update()
        .where(
            Bet.fight_round == current_round,
            Bet.status == BetStatusEnum.PENDING,
            Bet.bet_type != winning_bet_type,
        )
        .values(
            status=BetStatusEnum.LOST,
            payout_ratio=0.0,
            payout_amount=0.0,
        )
    )
    await db.commit()

    # Transition immediately to redeeming phase
    FightStateService.set_phase(FightPhase.REDEEMING)
    return {
        "status": f"Results processed for fight round {current_round}. Winning side: {winning_bet_type.value}. System now in REDEEMING phase.",
        "fight_round": current_round,
        "total_net_pool": round(total_net_pool, 2),
        "winning_net_pool": round(winning_net_pool, 2),
        "payout_ratio": payout_ratio,
    }

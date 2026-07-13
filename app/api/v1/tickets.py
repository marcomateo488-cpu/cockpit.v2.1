import uuid
from typing import Optional
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from app.core.config import settings
from app.core.database import get_db
from app.api.auth_deps import require_teller
from app.models.user import User
from app.models.bet import Bet, BetStatusEnum
from app.schemas.ticket import BetCreate, ReceiptResponse, RedeemResponse
from app.services.fight_state_service import FightStateService, FightPhase
from app.services.barcode_service import generate_barcode_base64

router = APIRouter(prefix="/tickets", tags=["Ticket Issuance & Redemption"])

@router.post("", response_model=ReceiptResponse)
async def create_bet_ticket(bet_in: BetCreate, db: AsyncSession = Depends(get_db), teller: User = Depends(require_teller)):
    """Creates a ticket, deducts 15% tax immediately, and outputs a receipt barcode."""
    # Strict validation: Rejects requests immediately if not in BETTING phase
    FightStateService.enforce_phase(FightPhase.BETTING)

    tax_amount = round(bet_in.amount * settings.TAX_RATE, 2)
    net_amount = round(bet_in.amount - tax_amount, 2)

    barcode_string = f"CF-{uuid.uuid4().hex.upper()[:10]}"

    new_bet = Bet(
        barcode=barcode_string,
        teller_id=teller.id,
        fight_round=FightStateService.get_round(),
        bet_type=bet_in.bet_type,
        gross_amount=bet_in.amount,
        tax_amount=tax_amount,
        net_amount=net_amount,
        payout_amount=0.0,
        payout_ratio=0.0
    )

    db.add(new_bet)
    await db.commit()
    await db.refresh(new_bet)

    return ReceiptResponse(
        transaction_id=new_bet.id,
        fight_round=new_bet.fight_round,
        barcode_base64=generate_barcode_base64(barcode_string),
        bet_type=new_bet.bet_type,
        gross_amount=new_bet.gross_amount,
        tax_deducted=new_bet.tax_amount,
        net_amount=new_bet.net_amount,
        created_at=new_bet.created_at
    )

@router.get("")
async def list_my_tickets(
    search: Optional[str] = None,
    fight_round: Optional[int] = None,
    all_rounds: bool = False,
    db: AsyncSession = Depends(get_db),
    teller: User = Depends(require_teller),
):
    """
    A teller's own transaction history. Defaults to the current round only;
    pass all_rounds=true to see everything, or fight_round=N for a specific
    past round. `search` matches against barcode or transaction ID.
    """
    target_round = fight_round if fight_round is not None else FightStateService.get_round()

    stmt = select(Bet).where(Bet.teller_id == teller.id).order_by(Bet.created_at.desc())
    if not all_rounds:
        stmt = stmt.where(Bet.fight_round == target_round)
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(Bet.barcode.ilike(like), Bet.id.ilike(like)))
    stmt = stmt.limit(300)

    result = await db.execute(stmt)
    return {
        "current_round": FightStateService.get_round(),
        "viewing_round": None if all_rounds else target_round,
        "transactions": result.scalars().all(),
    }

@router.get("/{ticket_id}")
async def get_my_ticket_detail(ticket_id: str, db: AsyncSession = Depends(get_db), teller: User = Depends(require_teller)):
    """Full detail view (with a freshly rendered barcode image) for one of the teller's own tickets."""
    result = await db.execute(select(Bet).where(Bet.id == ticket_id, Bet.teller_id == teller.id))
    bet = result.scalar_one_or_none()
    if not bet:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found.")

    return {
        "transaction_id": bet.id,
        "fight_round": bet.fight_round,
        "barcode": bet.barcode,
        "barcode_base64": generate_barcode_base64(bet.barcode),
        "bet_type": bet.bet_type,
        "gross_amount": bet.gross_amount,
        "tax_amount": bet.tax_amount,
        "net_amount": bet.net_amount,
        "status": bet.status,
        "payout_amount": bet.payout_amount,
        "payout_ratio": bet.payout_ratio,
        "is_redeemed": bet.is_redeemed,
        "created_at": bet.created_at,
        "redeemed_at": bet.redeemed_at,
    }

@router.post("/redeem/{ticket_ref}", response_model=RedeemResponse)
async def redeem_ticket(ticket_ref: str, db: AsyncSession = Depends(get_db), teller: User = Depends(require_teller)):
    """
    Atomic scan execution. Locks the database row using FOR UPDATE to prevent double-scan loopholes.

    Accepts EITHER the printed barcode OR the transaction ID, so a teller can
    still process a payout by typing the transaction ID if a barcode fails
    to scan or print correctly.
    """
    FightStateService.enforce_phase(FightPhase.REDEEMING)

    stmt = select(Bet).where(or_(Bet.barcode == ticket_ref, Bet.id == ticket_ref)).with_for_update()
    result = await db.execute(stmt)
    bet = result.scalar_one_or_none()

    if not bet:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No ticket found for that barcode or transaction ID.")

    if bet.is_redeemed:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="TICKET VOID: This ticket has already been scanned and paid out.")

    if bet.status not in (BetStatusEnum.WON, BetStatusEnum.REFUNDED):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Ticket is not eligible for payout. Status: {bet.status.value}")

    bet.is_redeemed = True
    bet.redeemed_at = datetime.now(timezone.utc)
    await db.commit()

    if bet.status == BetStatusEnum.REFUNDED:
        payout_status = "REFUNDED"
        message = "Fight was declared a draw/no-decision. Dispense original net stake to customer."
    else:
        payout_status = "APPROVED"
        message = "Valid ticket. Dispense net payout to customer."

    return RedeemResponse(
        transaction_id=bet.id,
        payout_status=payout_status,
        payout_amount=bet.payout_amount,
        message=message
    )

from typing import Optional
from sqlalchemy import func, or_
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from app.core.database import get_db
from app.api.auth_deps import require_admin
from app.models.user import User
from app.models.bet import Bet
from app.models.audit_log import AuditLog
from app.services.fight_state_service import FightStateService
from app.services.barcode_service import generate_barcode_base64

router = APIRouter(prefix="/admin", tags=["Admin Reports"])

@router.get("/monitor/tellers")
async def monitor_tellers(
    fight_round: Optional[int] = None,
    all_rounds: bool = False,
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Live audit tracking of transactions processed across teller IDs.

    By default shows only the CURRENT fight round's tickets. Pass
    all_rounds=true to see everything, or fight_round=N for a specific past
    round. `search` matches against barcode or transaction ID. Also returns
    a `round_summary` with the always-current round's ticket count and total
    staked, independent of whichever round/search you're currently viewing.
    """
    current_round = FightStateService.get_round()
    target_round = fight_round if fight_round is not None else current_round

    stmt = select(Bet).order_by(Bet.created_at.desc())
    if not all_rounds:
        stmt = stmt.where(Bet.fight_round == target_round)
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(Bet.barcode.ilike(like), Bet.id.ilike(like)))
    stmt = stmt.limit(300)

    result = await db.execute(stmt)

    summary_stmt = select(
        func.count(Bet.id), func.sum(Bet.gross_amount), func.sum(Bet.net_amount)
    ).where(Bet.fight_round == current_round)
    summary_result = await db.execute(summary_stmt)
    ticket_count, total_gross, total_net = summary_result.one()

    return {
        "current_round": current_round,
        "viewing_round": None if all_rounds else target_round,
        "recent_transactions": result.scalars().all(),
        "round_summary": {
            "fight_round": current_round,
            "ticket_count": ticket_count or 0,
            "total_gross": round(total_gross or 0.0, 2),
            "total_net": round(total_net or 0.0, 2),
        },
    }

@router.get("/tickets/{ticket_id}")
async def get_ticket_detail(ticket_id: str, db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)):
    """Full detail view (with a freshly rendered barcode image) for any ticket, for admin lookup."""
    result = await db.execute(select(Bet).where(Bet.id == ticket_id))
    bet = result.scalar_one_or_none()
    if not bet:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found.")

    return {
        "transaction_id": bet.id,
        "fight_round": bet.fight_round,
        "barcode": bet.barcode,
        "barcode_base64": generate_barcode_base64(bet.barcode),
        "teller_id": bet.teller_id,
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

@router.get("/reports/daily-income")
async def daily_income_report(db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)):
    """Total gross wagered, tax withheld, and net staked, grouped by calendar date, across all fight rounds."""
    day_expr = func.date(Bet.created_at)
    stmt = (
        select(
            day_expr.label("day"),
            func.count(Bet.id).label("ticket_count"),
            func.sum(Bet.gross_amount).label("total_gross"),
            func.sum(Bet.tax_amount).label("total_tax"),
            func.sum(Bet.net_amount).label("total_net"),
        )
        .group_by(day_expr)
        .order_by(day_expr.desc())
    )
    result = await db.execute(stmt)
    rows = result.all()
    return {
        "days": [
            {
                "date": str(r.day),
                "ticket_count": r.ticket_count,
                "total_gross": round(r.total_gross or 0.0, 2),
                "total_tax": round(r.total_tax or 0.0, 2),
                "total_net": round(r.total_net or 0.0, 2),
            }
            for r in rows
        ]
    }

@router.get("/audit-logs")
async def list_audit_logs(
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Login/logout history for every account, most recent first. `search` matches against username."""
    stmt = select(AuditLog).order_by(AuditLog.timestamp.desc())
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(AuditLog.username.ilike(like))
    stmt = stmt.limit(500)
    result = await db.execute(stmt)
    return {"logs": result.scalars().all()}

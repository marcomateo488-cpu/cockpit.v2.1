import enum
import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, String, Float, Boolean, Enum, ForeignKey, DateTime, Integer
from app.core.database import Base

class BetTypeEnum(str, enum.Enum):
    MERON = "MERON"
    WALA = "WALA"
    DRAW = "DRAW"

class BetStatusEnum(str, enum.Enum):
    PENDING = "PENDING"
    WON = "WON"
    LOST = "LOST"
    REFUNDED = "REFUNDED"

class Bet(Base):
    __tablename__ = "bets"

    id = Column(String, primary_key=True, default=lambda: f"TXN-{uuid.uuid4().hex.upper()[:12]}")
    barcode = Column(String, unique=True, index=True, nullable=False)
    teller_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    # Ties every bet to the specific cockfight queue/round it was placed in.
    # This keeps each fight's pari-mutuel pool isolated from every other fight
    # (past and future), instead of mixing all bets ever placed into one pool.
    fight_round = Column(Integer, nullable=False, index=True, default=0)

    bet_type = Column(Enum(BetTypeEnum), nullable=False)
    gross_amount = Column(Float, nullable=False)
    tax_amount = Column(Float, nullable=False)
    net_amount = Column(Float, nullable=False)

    # Pari-Mutuel algorithm fields
    payout_amount = Column(Float, default=0.0, nullable=False)
    payout_ratio = Column(Float, default=0.0, nullable=False)

    status = Column(Enum(BetStatusEnum), default=BetStatusEnum.PENDING, nullable=False)
    is_redeemed = Column(Boolean, default=False, nullable=False)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    redeemed_at = Column(DateTime(timezone=True), nullable=True)

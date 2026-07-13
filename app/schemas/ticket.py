from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional
from app.models.bet import BetTypeEnum, BetStatusEnum

class BetCreate(BaseModel):
    bet_type: BetTypeEnum
    amount: float = Field(..., gt=0, description="Gross bet amount must be greater than zero")

class ReceiptResponse(BaseModel):
    transaction_id: str
    fight_round: int
    barcode_base64: str
    bet_type: BetTypeEnum
    gross_amount: float
    tax_deducted: float
    net_amount: float
    created_at: datetime

class RedeemResponse(BaseModel):
    transaction_id: str
    payout_status: str
    payout_amount: float
    message: str

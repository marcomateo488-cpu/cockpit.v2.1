from fastapi import APIRouter, Depends
from app.api.auth_deps import get_current_user
from app.models.user import User
from app.services.fight_state_service import FightStateService

router = APIRouter(prefix="/status", tags=["System Status"])

@router.get("/phase")
async def get_current_phase(current_user: User = Depends(get_current_user)):
    """
    Lightweight, role-agnostic endpoint for polling the current fight phase
    and round number. Both ADMIN and TELLER accounts can call this safely -
    it does not require admin privileges, unlike the admin fight-control
    endpoints.
    """
    return {
        "phase": FightStateService.get_phase().value,
        "fight_round": FightStateService.get_round(),
        "round_ready": FightStateService.is_round_ready(),
    }

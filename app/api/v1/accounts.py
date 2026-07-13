from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from app.core.database import get_db
from app.core.security import get_password_hash
from app.api.auth_deps import require_admin
from app.models.user import User, RoleEnum
from app.schemas.auth import UserCreate, UserResponse

router = APIRouter(prefix="/admin/accounts", tags=["Account Management"])

@router.get("", response_model=list[UserResponse])
async def list_users(db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)):
    """List every account (never returns password hashes)."""
    result = await db.execute(select(User).order_by(User.id))
    return result.scalars().all()

@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(user_in: UserCreate, db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)):
    """
    Create a new ADMIN or TELLER account. This is the only supported way to
    add accounts after initial setup — passwords are hashed here, server
    side, and never touch source code or shell history.
    """
    existing = await db.execute(select(User).where(User.username == user_in.username))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="That username is already taken.")

    new_user = User(
        username=user_in.username,
        hashed_password=get_password_hash(user_in.password),
        role=user_in.role,
        is_active=True,
    )
    db.add(new_user)
    await db.commit()
    await db.refresh(new_user)
    return new_user

@router.patch("/{user_id}/toggle-active", response_model=UserResponse)
async def toggle_user_active(user_id: int, db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)):
    """Deactivate or reactivate an account (e.g. a teller who no longer works here) without deleting its history."""
    if user_id == admin.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You can't deactivate your own account.")

    result = await db.execute(select(User).where(User.id == user_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found.")

    target.is_active = not target.is_active
    await db.commit()
    await db.refresh(target)
    return target

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from app.core.database import get_db
from app.core.security import verify_password, create_access_token
from app.api.auth_deps import get_current_user
from app.models.user import User
from app.models.audit_log import AuditLog, AuditActionEnum
from app.schemas.auth import Token

router = APIRouter(prefix="/auth", tags=["Authentication"])

@router.post("/login", response_model=Token)
async def login(form_data: OAuth2PasswordRequestForm = Depends(), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.username == form_data.username))
    user = result.scalar_one_or_none()

    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This account has been deactivated.")

    access_token = create_access_token(data={"sub": user.username, "role": user.role.value})

    db.add(AuditLog(user_id=user.id, username=user.username, role=user.role.value, action=AuditActionEnum.LOGIN))
    await db.commit()

    return {"access_token": access_token, "token_type": "bearer"}

@router.post("/logout")
async def logout(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    JWTs are stateless, so this doesn't invalidate the token server-side —
    it exists purely to record a LOGOUT event for the audit log. The
    frontend clears its own session storage regardless of whether this
    call succeeds.
    """
    db.add(AuditLog(user_id=current_user.id, username=current_user.username, role=current_user.role.value, action=AuditActionEnum.LOGOUT))
    await db.commit()
    return {"status": "logged out"}

import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.core.database import engine, Base, AsyncSessionLocal
from app.core.security import get_password_hash
from app.models.user import User, RoleEnum
from app.api.v1 import auth, fight_control, reports, tickets, phase_status, accounts

logger = logging.getLogger("uvicorn.error")

app = FastAPI(title=settings.PROJECT_NAME)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/v1")
app.include_router(fight_control.router, prefix="/api/v1")
app.include_router(reports.router, prefix="/api/v1")
app.include_router(tickets.router, prefix="/api/v1")
app.include_router(phase_status.router, prefix="/api/v1")
app.include_router(accounts.router, prefix="/api/v1")

@app.on_event("startup")
async def startup_event():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as db:
        from sqlalchemy.future import select
        result = await db.execute(select(User).where(User.role == RoleEnum.ADMIN))
        admin_exists = result.scalars().first() is not None

        if admin_exists:
            return

        if settings.INITIAL_ADMIN_USERNAME and settings.INITIAL_ADMIN_PASSWORD:
            db.add(User(
                username=settings.INITIAL_ADMIN_USERNAME,
                hashed_password=get_password_hash(settings.INITIAL_ADMIN_PASSWORD),
                role=RoleEnum.ADMIN,
            ))
            await db.commit()
            logger.warning(
                "="*70 + "\n"
                f"Bootstrapped initial admin account '{settings.INITIAL_ADMIN_USERNAME}' "
                "from INITIAL_ADMIN_USERNAME/INITIAL_ADMIN_PASSWORD in .env.\n"
                "Log in now, then REMOVE those two lines from .env — they are only "
                "meant to create this one account and should not stay in the file.\n"
                + "="*70
            )
        else:
            logger.warning(
                "="*70 + "\n"
                "No admin account exists yet, and INITIAL_ADMIN_USERNAME / "
                "INITIAL_ADMIN_PASSWORD are not set in .env. Add them, restart "
                "the server once to create the first admin, then remove them "
                "from .env. Additional accounts (admin or teller) should be "
                "created afterward via the admin dashboard's account manager, "
                "not by editing source code or .env again.\n"
                + "="*70
            )

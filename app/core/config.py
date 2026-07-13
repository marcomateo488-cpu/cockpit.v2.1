from typing import Optional
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    PROJECT_NAME: str = "Cockfight Engine API"
    DATABASE_URL: str
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480
    TAX_RATE: float = 0.15

    # Used ONLY to bootstrap the very first admin account on a brand new
    # database. Set these in your .env (never commit .env to source
    # control), start the server once, log in, then delete these two lines
    # from .env. If left blank and no admin exists yet, startup will just
    # log a warning instead of silently creating a default account.
    INITIAL_ADMIN_USERNAME: Optional[str] = None
    INITIAL_ADMIN_PASSWORD: Optional[str] = None

    class Config:
        env_file = ".env"

settings = Settings()

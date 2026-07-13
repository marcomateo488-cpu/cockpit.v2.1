import enum
from datetime import datetime, timezone
from sqlalchemy import Column, String, Integer, Enum, DateTime, ForeignKey
from app.core.database import Base

class AuditActionEnum(str, enum.Enum):
    LOGIN = "LOGIN"
    LOGOUT = "LOGOUT"

class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    # user_id kept nullable + username/role denormalized so history survives
    # even if an account is ever hard-deleted later (accounts are only ever
    # deactivated in this app today, but this keeps the log durable either way).
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    username = Column(String, nullable=False, index=True)
    role = Column(String, nullable=False)
    action = Column(Enum(AuditActionEnum), nullable=False)
    timestamp = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)

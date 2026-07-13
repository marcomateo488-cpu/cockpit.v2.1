from pydantic import BaseModel, Field
from app.models.user import RoleEnum

class Token(BaseModel):
    access_token: str
    token_type: str

class UserResponse(BaseModel):
    id: int
    username: str
    role: RoleEnum
    is_active: bool

    class Config:
        from_attributes = True

class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=8, description="At least 8 characters")
    role: RoleEnum

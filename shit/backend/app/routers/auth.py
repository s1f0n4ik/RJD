from fastapi import APIRouter, HTTPException, status, Depends
from app.models.user import LoginRequest, Token, UserResponse
from app.services.auth import authenticate_user, create_access_token, get_current_user

router = APIRouter()


@router.post("/login", response_model=Token)
async def login(request: LoginRequest):
    user = authenticate_user(request.username, request.password)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password"
        )

    access_token = create_access_token(data={"sub": user["username"], "role": user["role"]})

    return Token(
        access_token=access_token,
        role=user["role"],
        username=user["username"]
    )


@router.get("/me", response_model=UserResponse)
async def get_me(user: dict = Depends(get_current_user)):
    return UserResponse(username=user["username"], role=user["role"])
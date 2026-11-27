from fastapi import APIRouter, HTTPException, Request, Response, status, Depends
from app.models.user import LoginRequest, Token, UserResponse
from app.services import access
from app.services.auth import (
    ACCESS_TOKEN_EXPIRE_MINUTES, SESSION_COOKIE, USERS_DB, authenticate_user, create_access_token, get_current_user,
)

router = APIRouter()


def _session(request: Request, response: Response, user: dict) -> Token:
    # Токен в ответе и та же сессия в HttpOnly cookie; Secure только на удалённом входе
    access_token = create_access_token(data={"sub": user["username"], "role": user["role"]})
    response.set_cookie(
        SESSION_COOKIE, access_token, max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60, path="/",
        httponly=True, samesite="strict", secure=access.entrance(request) == "remote",
    )
    return Token(
        access_token=access_token,
        role=user["role"],
        username=user["username"]
    )


@router.post("/login", response_model=Token)
async def login(body: LoginRequest, request: Request, response: Response):
    user = authenticate_user(body.username, body.password)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password"
        )

    return _session(request, response, user)


# Viewer needs no credentials: the role only unlocks read access, so the
# login form offers it as a single button
@router.post("/viewer", response_model=Token)
async def login_viewer(request: Request, response: Response):
    user = next(u for u in USERS_DB.values() if u["role"] == "viewer")
    return _session(request, response, user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request):
    """Стирает cookie сессии."""
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.delete_cookie(
        SESSION_COOKIE, path="/", httponly=True, samesite="strict", secure=access.entrance(request) == "remote",
    )
    return response


@router.get("/policy")
async def policy(request: Request):
    """Вход, через который пришёл запрос, и нужен ли вход до любого экрана."""
    where = access.entrance(request)
    return {"entrance": where, "login_required": where == "remote"}


@router.get("/check", status_code=status.HTTP_204_NO_CONTENT)
async def check(request: Request):
    """Решение для auth_request nginx по X-Original-Method и X-Original-URI: 204, 401 или 403."""
    code = access.check_path(request, request.headers.get("x-original-method", "GET"), request.headers.get("x-original-uri", ""))
    if code:
        raise HTTPException(status_code=code, detail=access.DETAILS[code])
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=UserResponse)
async def get_me(user: dict = Depends(get_current_user)):
    return UserResponse(username=user["username"], role=user["role"])

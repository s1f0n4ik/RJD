import logging
import os
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import HTTPException, status, Request
from starlette.requests import HTTPConnection

from app.config import settings

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 480
SECRET_BYTES = 32
SESSION_COOKIE = "rjd_session"

logger = logging.getLogger(__name__)
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
_secret: Optional[bytes] = None


USERS_DB = {
    "admin": {
        "username": "admin",
        "password_hash": "$2b$12$A3IpNWdpg912GjcOe0kB4.c3Fx7SONXlW0IKe5Zp1amWvbDaV.BY2",
        "role": "admin"
    },
    "user": {
        "username": "user",
        "password_hash": "$2b$12$b/4n2FJenBziRNJGQRir7O1lgAogDGTzkVVXnBpmEG8mzhdYKDdH.",
        "role": "viewer"
    }
}


def load_secret() -> bytes:
    # Секрет из файла тома; нет файла или он повреждён — новый случайный с правами 0600
    global _secret
    if _secret is not None:
        return _secret
    path = Path(settings.AUTH_SECRET_FILE)
    try:
        value = path.read_bytes()
    except FileNotFoundError:
        value = b""
    if len(value) != SECRET_BYTES:
        invalid = bool(value)
        value = secrets.token_bytes(SECRET_BYTES)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(value)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        if invalid:
            logger.warning(f"Auth secret {path} was invalid, created a new one; issued tokens are void")
        else:
            logger.info(f"Created new auth secret {path}")
    os.chmod(path, 0o600)
    _secret = value
    return _secret


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def authenticate_user(username: str, password: str):
    user = USERS_DB.get(username)
    if not user:
        return None
    if not verify_password(password, user["password_hash"]):
        return None
    return user


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, load_secret(), algorithm=ALGORITHM)


def decode_token(token: str):
    try:
        payload = jwt.decode(token, load_secret(), algorithms=[ALGORITHM])
        return payload
    except JWTError:
        return None


def user_from_token(token: Optional[str]) -> Optional[dict]:
    payload = decode_token(token) if token else None
    if not payload:
        return None
    return USERS_DB.get(payload.get("sub") or "")


def request_user(conn: HTTPConnection) -> Optional[dict]:
    # Пользователь по заголовку Authorization: Bearer, при неверном или пустом — по cookie сессии
    scheme, _, token = conn.headers.get("authorization", "").partition(" ")
    if scheme.lower() == "bearer" and token.strip():
        user = user_from_token(token.strip())
        if user:
            return user
    return user_from_token(conn.cookies.get(SESSION_COOKIE))


async def get_current_user(request: Request):
    user = request_user(request)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        )
    return user

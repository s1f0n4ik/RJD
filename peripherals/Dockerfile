# Контекст сборки - корень репозитория: сервису нужен общий proto GetTime шлюза.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY peripherals/requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

COPY peripherals/proto/peripherals.proto ./proto/peripherals.proto
COPY message-gateway/proto/frame-ingress.proto ./proto/frame-ingress.proto
RUN python -m grpc_tools.protoc -I proto --python_out=. --grpc_python_out=. \
    proto/peripherals.proto proto/frame-ingress.proto

COPY peripherals/app/ ./app/

EXPOSE 8006 50053

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8006"]

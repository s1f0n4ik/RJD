# Версия питона общая с остальными сервисами, чтобы слои базы переиспользовались
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# Заглушки gRPC из proto в корень приложения
COPY proto/ ./proto/
RUN python -m grpc_tools.protoc -I proto --python_out=. --grpc_python_out=. proto/detection-ingress.proto proto/frame-ingress.proto

COPY fonts/ ./fonts/
COPY app/ ./app/

EXPOSE 8003 50052

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8003"]

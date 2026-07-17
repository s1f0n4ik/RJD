# Версия питона общая с остальными сервисами, чтобы слои базы переиспользовались
FROM python:3.12-slim

WORKDIR /app

# Копируем и устанавливаем зависимости
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# Копируем код сервера
COPY server.py .

# Порт для WebSocket
EXPOSE 8765

# Запуск signaling сервера
CMD ["python", "server.py"]

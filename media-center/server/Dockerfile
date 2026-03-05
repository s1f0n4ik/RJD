FROM python:3.10-slim

WORKDIR /app

# Копируем и устанавливаем зависимости
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Копируем код сервера
COPY server.py .

# Порт для WebSocket
EXPOSE 8765

# Запуск signaling сервера
CMD ["python", "server.py"]
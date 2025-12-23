FROM python:3.10-slim

WORKDIR /app

# Копируем requirements
COPY app/requirements.txt .

# Устанавливаем зависимости
RUN pip install --no-cache-dir -r requirements.txt

# Копируем весь код приложения
COPY app/ ./app/

# Порт для FastAPI
EXPOSE 8000

# Запуск FastAPI с uvicorn
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
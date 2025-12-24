FROM python:3.10-slim

WORKDIR /app

# Установка системных зависимостей для OpenCV
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Копируем requirements
COPY requirements.txt .

# Устанавливаем зависимости
RUN pip install --no-cache-dir -r requirements.txt

# Копируем весь код
COPY . .

# Порт для Flask
EXPOSE 5000

# Запуск Flask-сервера
CMD ["python", "main.py"]
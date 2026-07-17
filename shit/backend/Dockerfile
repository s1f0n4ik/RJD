# Версия питона общая с остальными сервисами, чтобы слои базы переиспользовались
FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive

# docker-clean удаляет скачанные пакеты после установки и обесценивает
# кеш-маунт, поэтому его убираем. Маунт /var/cache/apt общий с остальными
# сервисами, так что ffmpeg скачивается по сети только один раз на всю сборку.
# Списки apt лежат на маунте и в слой образа не попадают.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg

WORKDIR /app

# Копируем requirements
COPY app/requirements.txt .

# Устанавливаем зависимости
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# Копируем весь код приложения
COPY app/ ./app/

# Порт для FastAPI
EXPOSE 8000

# Запуск FastAPI с uvicorn
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

# Версия питона общая с остальными сервисами, чтобы слои базы переиспользовались
FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive

# ffmpeg для склейки. docker-clean обесценивает кеш-маунт, убираем его.
# Маунт /var/cache/apt общий с остальными сервисами, поэтому пакеты
# скачиваются по сети только один раз на всю сборку.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg

WORKDIR /app

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

COPY app/ ./app/

EXPOSE 8001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]

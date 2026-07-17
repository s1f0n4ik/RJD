# Dockerfile — Camera Scanner Service (ONVIF WS-Discovery)
#
# ВАЖНО: WS-Discovery работает через multicast. Контейнер ОБЯЗАН
# запускаться с host-сетью, иначе multicast не дойдёт до камер:
#
#   docker build -t camera-scanner .
#   docker run -d --name camera-scanner --network host --restart unless-stopped camera-scanner
#
# Bridge-сеть (по умолчанию) НЕ пропускает multicast — камеры не найдутся.

# Версия питона общая с остальными сервисами, чтобы слои базы переиспользовались
FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive

# Системные зависимости для onvif-zeep (lxml требует libxml2/libxslt).
# docker-clean обесценивает кеш-маунт, убираем его.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
        libxml2 \
        libxslt1.1

WORKDIR /app

# Сначала зависимости — кешируется отдельным слоем
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# Код приложения
COPY /app ./app/

EXPOSE 8002

# Без --reload в проде
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002"]

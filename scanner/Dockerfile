# Dockerfile — Camera Scanner Service (ONVIF WS-Discovery)
#
# ВАЖНО: WS-Discovery работает через multicast. Контейнер ОБЯЗАН
# запускаться с host-сетью, иначе multicast не дойдёт до камер:
#
#   docker build -t camera-scanner .
#   docker run -d --name camera-scanner --network host --restart unless-stopped camera-scanner
#
# Bridge-сеть (по умолчанию) НЕ пропускает multicast — камеры не найдутся.

FROM python:3.11-slim

# Системные зависимости для onvif-zeep (lxml требует libxml2/libxslt)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libxml2 \
        libxslt1.1 \
        && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Сначала зависимости — кешируется отдельным слоем
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Код приложения
COPY /app ./app/

EXPOSE 8002

# Без --reload в проде
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002"]
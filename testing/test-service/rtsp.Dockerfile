# Камера из видеозаписи для запуска на ПК: только RTSP-сервер rtsp.py, записи монтируются в /clips
# docker build -t rjd-rtsp-camera -f testing/test-service/rtsp.Dockerfile testing/test-service
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-gi gir1.2-gst-rtsp-server-1.0 gstreamer1.0-tools gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly gstreamer1.0-libav && rm -rf /var/lib/apt/lists/*
COPY rtsp.py /opt/rtsp.py
EXPOSE 8560
ENTRYPOINT ["python3", "/opt/rtsp.py"]

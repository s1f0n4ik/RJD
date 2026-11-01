FROM node:22-bookworm-slim AS node
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-gi gir1.2-gst-rtsp-server-1.0 gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly gstreamer1.0-libav chromium ffmpeg ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN python3 -m venv --system-site-packages /opt/venv
ENV PATH=/opt/venv/bin:$PATH CHROME_BIN=/usr/bin/chromium TMPDIR=/data/private/tmp
COPY testing/test-service/requirements.txt /opt/requirements.txt
RUN pip install --no-cache-dir -r /opt/requirements.txt
COPY testing/system/recording.py /opt/reuse/system/recording.py
COPY testing/can-server/codec.py /opt/reuse/can/codec.py
COPY testing/krsps-master/server.py /opt/reuse/modbus/server.py
COPY message-gateway/proto /opt/proto
RUN mkdir /opt/stubs && python -m grpc_tools.protoc -I/opt/proto --python_out=/opt/stubs --grpc_python_out=/opt/stubs /opt/proto/frame-ingress.proto
ENV PYTHONPATH=/opt/stubs
COPY testing/test-service /opt/testing
COPY shit/frontend/public/fonts /opt/testing/static/fonts
COPY shit/frontend/src/styles/tokens.css /opt/testing/static/tokens.css
WORKDIR /opt/testing
CMD ["python", "main.py"]

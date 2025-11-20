# Stage 1: Builder
FROM arm64v8/ubuntu:22.04 as builder
LABEL authors="s1f0n4ik"
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    git \
    pkg-config \
    python3-dev \
    python3-pip \
    libavcodec-dev \
    libavformat-dev \
    libavutil-dev \
    libswscale-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Install Python dependencies
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt


# Stage 2: Runtime
FROM arm64v8/ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    librockchip-mpp1 \
    librockchip-vpu0 \
    ntp \
    ntpdate \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Rockchip hardware acceleration support
RUN apt-get update && apt-get install -y \
    libmali-g610 \
    rockchip-multimedia-config \
    || echo "Rockchip packages not available, continuing without HW acceleration"

WORKDIR /app

# Copy Python dependencies from builder
COPY --from=builder /usr/local/lib/python3.10/dist-packages /usr/local/lib/python3.10/dist-packages

# Copy application code
COPY video_recorder.py .
COPY ntp_sync_server.py .

# Create directories
RUN mkdir -p /config /recordings /logs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python3 -c "import requests; requests.get('http://localhost:8123/health')" || exit 1

EXPOSE 8123

CMD ["python3", "video_recorder.py"]
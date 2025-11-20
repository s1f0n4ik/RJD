#!/bin/bash
# Orange Pi 5B Deployment Script

set -e

echo "=== Orange Pi 5B Video Recorder Deployment ==="

# Configuration
PROJECT_DIR="/opt/video-recorder"
STORAGE_DIR="/mnt/storage/recordings"

# Check if running on Orange Pi 5B
check_platform() {
    echo "Checking platform..."
    if grep -q "Orange Pi 5B" /proc/device-tree/model 2>/dev/null; then
        echo "✓ Running on Orange Pi 5B"
    else
        echo "⚠ Warning: Not detected as Orange Pi 5B"
        read -p "Continue anyway? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
}

# Install dependencies
install_dependencies() {
    echo "Installing system dependencies..."

    sudo apt-get update
    sudo apt-get install -y \
        docker.io \
        docker-compose \
        ffmpeg \
        git \
        ntp \
        python3-pip

    # Enable and start Docker
    sudo systemctl enable docker
    sudo systemctl start docker

    # Add user to docker group
    sudo usermod -aG docker $USER

    echo "✓ Dependencies installed"
}

# Setup storage
setup_storage() {
    echo "Setting up storage..."

    # Create storage directory
    sudo mkdir -p $STORAGE_DIR
    sudo chown -R $USER:$USER $STORAGE_DIR

    # Check available space
    AVAILABLE=$(df -BG $STORAGE_DIR | tail -1 | awk '{print $4}' | sed 's/G//')
    echo "Available storage: ${AVAILABLE}GB"

    if [ "$AVAILABLE" -lt 50 ]; then
        echo "⚠ Warning: Less than 50GB available"
    fi

    echo "✓ Storage configured"
}

# Configure Rockchip hardware acceleration
configure_hardware() {
    echo "Configuring Rockchip hardware acceleration..."

    # Check for MPP (Media Process Platform)
    if [ -e /dev/mpp_service ]; then
        echo "✓ MPP device found"
        sudo chmod 666 /dev/mpp_service
    else
        echo "⚠ MPP device not found"
    fi

    # Check for DMA heap
    if [ -d /dev/dma_heap ]; then
        echo "✓ DMA heap found"
        sudo chmod -R 666 /dev/dma_heap/*
    fi

    echo "✓ Hardware configuration completed"
}

# Deploy application
deploy_application() {
    echo "Deploying application..."

    # Create project directory
    sudo mkdir -p $PROJECT_DIR
    cd $PROJECT_DIR

    # Copy files (assumes they're in current directory)
    sudo cp -r config docker-compose.yml Dockerfile *.py requirements.txt $PROJECT_DIR/

    # Build Docker images
    echo "Building Docker images..."
    docker-compose build

    echo "✓ Application deployed"
}

# Start services
start_services() {
    echo "Starting services..."

    cd $PROJECT_DIR
    docker-compose up -d

    echo "✓ Services started"

    # Show status
    docker-compose ps
}

# Setup systemd service
setup_systemd() {
    echo "Setting up systemd service..."

    sudo tee /etc/systemd/system/video-recorder.service > /dev/null <<EOF
[Unit]
Description=Orange Pi Video Recorder
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/docker-compose up -d
ExecStop=/usr/bin/docker-compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable video-recorder.service

    echo "✓ Systemd service configured"
}

# Main execution
main() {
    check_platform
    install_dependencies
    setup_storage
    configure_hardware
    deploy_application
    start_services
    setup_systemd

    echo ""
    echo "=== Deployment Complete ==="
    echo "Access web dashboard: http://$(hostname -I | awk '{print $1}'):8080"
    echo "NTP server API: http://$(hostname -I | awk '{print $1}'):8123"
    echo ""
    echo "Commands:"
    echo "  View logs: docker-compose logs -f"
    echo "  Stop: docker-compose down"
    echo "  Restart: docker-compose restart"
}

main
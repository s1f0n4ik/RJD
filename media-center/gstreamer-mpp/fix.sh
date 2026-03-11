#!/bin/bash
set -e

LIB_DIR="/usr/lib/aarch64-linux-gnu"

echo "Creating symlinks in $LIB_DIR..."

cd "$LIB_DIR"

# RGA
if [ -f "librga.so.2.1.0" ]; then
    ln -sf librga.so.2.1.0 librga.so.2
    ln -sf librga.so.2.1.0 librga.so
fi

# Rockchip MPP
if [ -f "librockchip_mpp.so.0" ]; then
    ln -sf librockchip_mpp.so.0 librockchip_mpp.so.1
    ln -sf librockchip_mpp.so.0 librockchip_mpp.so
fi

# Rockchip VPU
if [ -f "librockchip_vpu.so.0" ]; then
    ln -sf librockchip_vpu.so.0 librockchip_vpu.so.1
    ln -sf librockchip_vpu.so.0 librockchip_vpu.so
fi

if [ -f "libgstbasecamerabinsrc-1.0.so.0.2800.0" ]; then
    ln -sf libgstbasecamerabinsrc-1.0.so.0.2800.0 libgstbasecamerabinsrc-1.0.so.0
    ln -sf libgstbasecamerabinsrc-1.0.so.0.2800.0 libgstbasecamerabinsrc-1.0.so
fi

echo "Symlinks created successfully."

chmod +x /usr/libexec/gstreamer-1.0/*
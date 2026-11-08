#!/bin/sh
set -e

echo "============================================================"
echo "  Hi-oT Smart Home Bridge for Home Assistant"
echo "  Hyundai AutoEver Hillstate Interoperability Bridge"
echo "============================================================"

# Ensure persistent session directory
mkdir -p /data

exec node src/hiot-ha-bridge.js

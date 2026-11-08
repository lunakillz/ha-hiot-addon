#!/bin/sh
set -e

echo "============================================================"
echo "  Hi-oT Smart Home Bridge for Home Assistant"
echo "  Hyundai AutoEver Hillstate Interoperability Bridge"
echo "============================================================"

# Ensure persistent session directory
mkdir -p /data

# Check if HA config directory is mapped (homeassistant_config:rw -> /homeassistant or /config)
HA_DIR=""
if [ -d "/homeassistant" ]; then
  HA_DIR="/homeassistant"
elif [ -d "/config" ]; then
  HA_DIR="/config"
fi

if [ -n "$HA_DIR" ]; then
  echo "[Hi-oT Add-on] HA config directory detected at $HA_DIR"
  mkdir -p "$HA_DIR/www/community/HaCasa"
  if [ ! -s "$HA_DIR/www/community/HaCasa/hacasa-nova.js" ]; then
    echo "[Hi-oT Add-on] Downloading HaCasa Nova v3.1.0 frontend card..."
    if command -v curl >/dev/null 2>&1; then
      curl -fSL -o "$HA_DIR/www/community/HaCasa/hacasa-nova.js" https://github.com/damianeickhoff/HaCasa/releases/download/v3.1.0/hacasa-nova.js || true
    elif command -v wget >/dev/null 2>&1; then
      wget -q -O "$HA_DIR/www/community/HaCasa/hacasa-nova.js" https://github.com/damianeickhoff/HaCasa/releases/download/v3.1.0/hacasa-nova.js || true
    fi
    if [ -s "$HA_DIR/www/community/HaCasa/hacasa-nova.js" ]; then
      echo "[Hi-oT Add-on] HaCasa Nova card installed successfully to $HA_DIR/www/community/HaCasa/hacasa-nova.js"
    else
      echo "[Hi-oT Add-on] Warning: Failed to download HaCasa Nova card."
    fi
  else
    echo "[Hi-oT Add-on] HaCasa Nova card already present at $HA_DIR/www/community/HaCasa/hacasa-nova.js"
  fi

  # Ensure Korean/non-Latin room slug navigation support in HaCasa Nova
  if [ -f "$HA_DIR/www/community/HaCasa/hacasa-nova.js" ]; then
    node -e '
      const fs = require("fs");
      const file = process.argv[1];
      let code = fs.readFileSync(file, "utf8");
      let changed = false;
      if (code.includes("let u=gt(s.name)") && !code.includes("let u=gt(s.name)||s.area_id")) {
        code = code.replace("let u=gt(s.name)", "let u=gt(s.name)||s.area_id");
        changed = true;
      }
      if (code.includes("slug:gt(b.name)") && !code.includes("slug:gt(b.name)||b.area_id")) {
        code = code.replace("slug:gt(b.name)", "slug:gt(b.name)||b.area_id");
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(file, code, "utf8");
        console.log("[Hi-oT Add-on] Successfully patched HaCasa Nova Korean room slug navigation.");
      }
    ' "$HA_DIR/www/community/HaCasa/hacasa-nova.js"
  fi
fi

exec node src/hiot-ha-bridge.js

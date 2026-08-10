#!/usr/bin/env bash
set -euo pipefail

SOURCE=/home/ubuntu/oddsdesk-deploy
TARGET=/opt/oddsdesk
DEMO_CONFIG=/home/ubuntu/.okx/config.toml

sudo rsync -a --chown=oddsdesk:oddsdesk "$SOURCE/" "$TARGET/"
sudo install -o oddsdesk -g oddsdesk -m 600 /home/ubuntu/runtime-profile.demo.yaml "$TARGET/config/runtime-profile.demo.yaml"
sudo install -d -o root -g root -m 755 /etc/oddsdesk
sudo install -o root -g root -m 600 /home/ubuntu/demo.env /etc/oddsdesk/demo.env

# Copy exactly one API profile. Live profiles never enter the service account's
# home, so a demo process cannot be switched to real funds by changing argv.
credential_tmp="$(mktemp)"
chmod 600 "$credential_tmp"
awk '
  /^\[profiles\.okx-demo\]$/ { copying=1 }
  /^\[/ && copying && $0 != "[profiles.okx-demo]" { exit }
  copying { print }
' "$DEMO_CONFIG" > "$credential_tmp"
grep -q '^\[profiles\.okx-demo\]$' "$credential_tmp"
grep -q '^demo[[:space:]]*=[[:space:]]*true$' "$credential_tmp"
sudo install -d -o oddsdesk -g oddsdesk -m 700 "$TARGET/.okx"
sudo install -o oddsdesk -g oddsdesk -m 600 "$credential_tmp" "$TARGET/.okx/config.toml"
shred -u "$credential_tmp"

sudo install -o root -g root -m 644 "$TARGET/ops/systemd/oddsdesk-demo.service" /etc/systemd/system/oddsdesk-demo.service
sudo systemctl daemon-reload

cd "$TARGET"
sudo -u oddsdesk npm ci --ignore-scripts=false
sudo -u oddsdesk npm run typecheck
sudo -u oddsdesk npm run build
sudo -u oddsdesk npm test

# No balance data is printed. This assertion proves both service-account access
# and the demo environment before systemd is allowed to start the engine.
preflight_tmp="$(mktemp)"
chmod 600 "$preflight_tmp"
sudo -u oddsdesk env HOME="$TARGET" NODE_OPTIONS=--dns-result-order=ipv4first \
  okx --profile okx-demo --json --env account balance > "$preflight_tmp"
grep -q '"env": "demo"' "$preflight_tmp"
shred -u "$preflight_tmp"

echo 'demo install verified; service remains stopped'

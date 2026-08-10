#!/usr/bin/env bash
set -euo pipefail

SOURCE=/home/ubuntu/oddsdesk-deploy
TARGET=/opt/oddsdesk
LIVE_CONFIG=/home/ubuntu/.okx/config.toml

# Preserve venue state and the service-only credential directory while updating
# the reviewed application snapshot.
sudo rsync -a --chown=oddsdesk:oddsdesk \
  --exclude='.git/' --exclude='.okx/' --exclude='.npm/' --exclude='var/' \
  "$SOURCE/" "$TARGET/"

sudo install -o oddsdesk -g oddsdesk -m 600 \
  /home/ubuntu/runtime-profile.tradekit.yaml \
  "$TARGET/config/runtime-profile.tradekit.yaml"
sudo install -d -o root -g root -m 755 /etc/oddsdesk
sudo install -o root -g root -m 600 /home/ubuntu/engine.env /etc/oddsdesk/engine.env

# Copy exactly the registered live sub-account profile. The production/main and
# demo profiles never enter the service account's home.
credential_tmp="$(mktemp)"
chmod 600 "$credential_tmp"
awk '
  /^\[profiles\.okx-sub\]$/ { copying=1 }
  /^\[/ && copying && $0 != "[profiles.okx-sub]" { exit }
  copying { print }
' "$LIVE_CONFIG" > "$credential_tmp"
grep -q '^\[profiles\.okx-sub\]$' "$credential_tmp"
grep -q '^demo[[:space:]]*=[[:space:]]*false$' "$credential_tmp"
sudo install -d -o oddsdesk -g oddsdesk -m 700 "$TARGET/.okx"
sudo install -o oddsdesk -g oddsdesk -m 600 "$credential_tmp" "$TARGET/.okx/config.toml"
shred -u "$credential_tmp"

sudo install -o root -g root -m 644 \
  "$TARGET/ops/systemd/oddsdesk-engine.service" \
  /etc/systemd/system/oddsdesk-engine.service
sudo systemctl daemon-reload

cd "$TARGET"
sudo -u oddsdesk npm ci --ignore-scripts=false
sudo -u oddsdesk npm run typecheck
sudo -u oddsdesk npm run build
sudo -u oddsdesk npm test

# Assert service-account access, the live environment, funded balance, position
# mode, and empty order/position state without printing account values.
sudo -u oddsdesk env HOME="$TARGET" NODE_OPTIONS=--dns-result-order=ipv4first \
  okx --profile okx-sub --json --env account balance > /tmp/oddsdesk-live-balance.json
grep -q '"env": "live"' /tmp/oddsdesk-live-balance.json
sudo -u oddsdesk env HOME="$TARGET" NODE_OPTIONS=--dns-result-order=ipv4first \
  okx --profile okx-sub account config | grep -q 'net_mode'
rm -f /tmp/oddsdesk-live-balance.json

echo 'live install verified; service remains stopped'

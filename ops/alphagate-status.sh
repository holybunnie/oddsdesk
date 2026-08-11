#!/usr/bin/env bash
# AlphaGate unattended status reporter.
# Read-only. Appends one line per run to the history log and rewrites a
# human-readable snapshot. Never touches the engine or the ASP daemon.
set -uo pipefail

VAR=/opt/oddsdesk/var
HIST="$VAR/status-history.log"
SNAP="$VAR/status-latest.txt"
AS_ENGINE=(sudo -u oddsdesk env HOME=/opt/oddsdesk NODE_OPTIONS=--dns-result-order=ipv4first)
NOW=$(date -u '+%Y-%m-%d %H:%M:%SZ')

engine=$(systemctl is-active oddsdesk-engine.service 2>/dev/null || echo unknown)
restarts=$(systemctl show oddsdesk-engine.service -p NRestarts --value 2>/dev/null || echo '?')
a2a=$(sudo -u ubuntu XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-active okx-a2a.service 2>/dev/null || echo unknown)

# The exact call that fails first when the wallet session expires.
if timeout 60 "${AS_ENGINE[@]}" /usr/local/bin/onchainos agent subscribe-active --agent-id 10706 2>&1 | grep -q '"ok":true'; then
  session=ok
else
  session=EXPIRED
fi

# Output is a plain table, not JSON: a `USDT <equity> <available> <frozen>` row.
bal=$(timeout 60 "${AS_ENGINE[@]}" okx --profile okx-sub account balance 2>/dev/null | head -c 2000 || true)
equity=$(awk '$1=="USDT"{print $2; exit}' <<<"$bal")
[ -z "${equity:-}" ] && equity='?'

pos=$(timeout 60 "${AS_ENGINE[@]}" okx --profile okx-sub account positions 2>&1 | head -c 2000 || true)
if grep -qi 'no open positions' <<<"$pos"; then poscount=0; else poscount=$(grep -oc '"instId"' <<<"$pos" || echo '?'); fi

cycle=$(journalctl -u oddsdesk-engine.service --since '-24h' --no-pager 2>/dev/null | grep -F '[cycle]' | tail -1)
signal=$(journalctl -u oddsdesk-engine.service --since '-24h' --no-pager 2>/dev/null | grep -F '[signal]' | tail -1)
# grep -c prints 0 and exits 1 on no match; `|| echo 0` would append a SECOND
# zero and produce a two-line count. The printed value is already correct.
submitted=$(journalctl -u oddsdesk-engine.service --since '-14d' --no-pager 2>/dev/null | grep -cF 'SUBMITTED')
refused24=$(journalctl -u oddsdesk-engine.service --since '-24h' --no-pager 2>/dev/null | grep -cF 'REFUSED')

echo "$NOW engine=$engine restarts=$restarts a2a=$a2a session=$session equity=$equity positions=$poscount submitted_total=$submitted refused_24h=$refused24" >> "$HIST"

{
  echo "AlphaGate status — $NOW"
  echo
  echo "engine            : $engine (restarts $restarts, Restart=always)"
  echo "ASP daemon        : $a2a   <- must stay active (rule 3.2)"
  echo "wallet session    : $session"
  echo "equity            : $equity USDT"
  echo "open positions    : $poscount"
  echo "orders SUBMITTED  : $submitted   <- rule 3.1 needs at least 1 valid trade"
  echo "signals REFUSED   : $refused24 in last 24h"
  echo
  echo "last cycle  : ${cycle:-none in 24h}"
  echo "last signal : ${signal:-none in 24h}"
  echo
  echo "History: $HIST"
  if [ "$session" = EXPIRED ]; then
    echo
    echo "ACTION REQUIRED: the wallet session has expired again; no signal can be"
    echo "delivered and therefore nothing will trade. Re-run the login in HANDOFF.md S14."
  fi
} > "$SNAP"

# Keep the history bounded.
tail -n 5000 "$HIST" > "$HIST.tmp" 2>/dev/null && mv "$HIST.tmp" "$HIST"
chmod 644 "$SNAP" "$HIST" 2>/dev/null || true

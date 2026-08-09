# Runtime units

Install these units only after the runtime profile records the venue result.
`oddsdesk-watchdog.service` is required when stops are observed as
`client-held`; it must not be enabled for `venue-held`, `unverified`, or `none`.

The engine writes `var/engine-heartbeat.json` every 10 seconds. The watchdog
trips the route-B kill switch and attempts to flatten every open position after
60 seconds without a fresh heartbeat. Set `ODDSDESK_ALERT_WEBHOOK` in the
environment file for a Telegram/Discord-compatible webhook bridge.

The units intentionally cap memory and restart on failure. Keep any unrelated
`delphi-agent` unit separate and apply its own `MemoryMax=350M` and
`Restart=always` policy on the host; it is not part of this repository.

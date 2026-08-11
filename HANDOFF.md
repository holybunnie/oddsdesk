# AlphaGate — Handoff

## 14. Session 10 — 2026-08-11 — wallet session restored

**Read this before §13; it resolves §13's single blocker.**

- The engine wallet session is **valid again**. `agent get` returns `ok:true`,
  and `agent subscribe-active --agent-id 10706` — the exact call that refused
  every signal all session 9 — returns `ok:true` with the `copyTrade:true`
  subscription. Wallet is the correct one: `0x4c24a3ef…529a0f05`, login type
  `google`, account `jennycruzzyy@gmail.com`.
- The ASP daemon was never touched and stayed active throughout.

### Unattended status reporting — read this first when you come back

`alphagate-status.timer` runs `/usr/local/bin/alphagate-status.sh` every 15
minutes (also 3 min after boot, `Persistent=true`), enabled so it survives
reboot. It is **read-only** and never touches the engine or the ASP daemon.
Sources are in `ops/alphagate-status.sh` and `ops/systemd/`.

- **`/opt/oddsdesk/var/status-latest.txt`** — current snapshot: engine, ASP
  daemon, wallet session, equity, open positions, total `SUBMITTED` orders,
  refusals in 24h, and the last cycle and signal lines.
- **`/opt/oddsdesk/var/status-history.log`** — one line per run, capped at 5000
  lines, so an outage that has since recovered is still visible after the fact.

Session expiry is detected by running the real `agent subscribe-active
--agent-id 10706` call rather than reading `session.json`, and the snapshot
prints `ACTION REQUIRED` when it fails. **There is still no off-box alerting**
(BUILD-SPEC Trap 4 layer (c)) — nothing pages you; the report has to be read.

### The live path is the frozen policy — `minConviction` is dead config there

`runScan` branches on `strategy.mode === 'frozen-short-continuation'` and takes
`runFrozenContinuationScan`, which **never calls `evaluateEntry`**. So
`config.signals.minConviction` (read only at `src/signal/entry.ts:248`) has no
effect in live trading, and lowering it to trade more often would change
nothing. The frozen path synthesises a conviction value from its own score
purely to populate the field.

The real gates are the frozen constants: `minAbsoluteScore 0.5`,
`minDirectionalBreadth 3`/6, `requireBtcAlignment`, on a **4-hour decision
cadence** (bars close 00/04/08/12/16/20 UTC). A quiet hour is usually the
cadence, not a fault. `frozen-continuation.ts` states that changing any constant
creates a new research candidate and must not be done as an operational edit.

### The dev environment loses the SSH key

`~/.ssh/oddsdesk_ed25519` did **not** survive; the dev container was rebuilt.
A new key (`oddsdesk-session10`) was generated and added to the VPS through the
**Lightsail browser console**, which is the only path in when no key works.
Expect to repeat this. Keeping the private key somewhere durable (a laptop)
avoids it. SSH keys do not expire — an absent key and an expired session are
different failures with the same symptom of "cannot get in".

When pasting a public key into the browser console, paste it in **short
chunks** (`K='<base64>'` then `echo "ssh-ed25519 $K <comment>"`). A wrapped
paste of the full line inserts real newlines and writes a broken three-line
key, which fails authentication exactly like no key at all.

### The poll trap, corrected — it was never only the timeout

§13 blamed the ~2 minute single-poll timeout. That is real but was **not** what
defeated this session's first attempts:

1. `nohup`/`setsid` backgrounding through a non-interactive `ssh` command
   **still died** when the SSH connection closed. Use a supervised transient
   unit instead, which init owns and no disconnect can reach:

   ```bash
   sudo systemd-run --unit=oddsdesk-wallet-login --uid=oddsdesk \
     --setenv=HOME=/opt/oddsdesk --collect bash -c '<poll loop>'
   ```

2. **The retry loop logged to `/tmp/login.log`, which was owned by another
   user.** Every iteration died instantly on the shell redirect — `Permission
   denied` — so 20 "attempts" burned in 40 seconds without ever running a
   single poll, and the unit exited looking like an honest exhaustion. Write
   the log somewhere `oddsdesk` owns, and **check the unit's journal, not just
   its exit status**: `Result=success` with `ExecMainStatus=0` was reported for
   a loop that never once contacted the venue.

A plain foreground poll against the still-valid session id succeeded
immediately once the browser sign-in was done. The login URL stays valid across
failed polls, so re-`init` is rarely needed.

## 2026-08-10 — competition posture increased to 3% risk

- At the user's explicit direction for a top-three mandate, fixed fractional
  risk was increased to **3% in all three stages**.
- The portfolio heat cap remains **6%**, so no more than two positions can carry
  full initial risk simultaneously. Isolated margin, venue-held stops, the 5x
  leverage ceiling, directional/correlation caps, and drawdown governors remain
  unchanged.
- At 319.897 USDT equity, initial stop risk is approximately **9.60 USDT per
  trade**. A +3R outcome is approximately +28.79 USDT before compounding.

## 2026-08-10 — live cutover complete

- The registered competition sub-account (`okx-sub`, UID remains redacted in
  chat) is funded with **319.897 USDT** in the trading account.
- The account was changed from `long_short_mode` to the required `net_mode`
  only after confirming there were no positions, regular orders, or algo
  orders. Those checks remained empty after cutover.
- The demo kill test recorded venue-held stops. The live runtime profile now
  records `venue-held`, `killTestObserved: true`, `net_mode`, and a maximum
  leverage ceiling of **5**.
- A stale pre-live state file contained the demo venue's ~4,999.99 USDT peak.
  The dry preflight caught it through the drawdown governor before any signal
  or order. The contaminated state and empty ledger were preserved at
  `/opt/oddsdesk/var/prelive-demo-contamination-20260810T2118Z`; clean live
  state initialized at 319.897 USDT equity and peak.
- The VPS typecheck/build and all **457 tests** passed. A stopped live dry cycle
  passed with the governor normal and no signal or order.
- `oddsdesk-demo.service` is now inactive and disabled.
  `oddsdesk-engine.service` is active and enabled with zero restarts and a
  current heartbeat. `okx-a2a.service` remains active and enabled.
- The live engine started before the competition window and correctly reports
  phase `before`; its hard gate prevents entries until
  **2026-08-11 04:00 UTC** (12:00 UTC+8). No live trade has yet been placed.
- A repeatable live deployment installer is at `ops/install-live.sh`. It copies
  only the `okx-sub` API profile into the service account and leaves the engine
  stopped for preflight.

## 2026-08-10 — confirmed competition registration and live cutover pause

- **AlphaGate is already registered for the OKX.AI Trading Hackathon.** A repeat
  registration attempt returned the authoritative rejection: an existing
  registration was found. Do not submit it again.
- The registered competition account is the dedicated CeFi / Agent Trade Kit
  sub-account. A read-only live account check confirmed that the configured
  `okx-sub` profile belongs to the registered UID (the UID remains redacted).
- The VPS resolves the OKX API endpoint to IPv6 unless explicitly constrained.
  The API key whitelist accepts the VPS IPv4 (`54.154.121.30`) but rejected its
  IPv6 address. All live engine and preflight commands must therefore include:

  ```text
  NODE_OPTIONS=--dns-result-order=ipv4first
  ```

  With that setting, authenticated live account queries succeed. Include it in
  `/etc/oddsdesk/engine.env` or the live systemd unit environment.
- Current live-account check: **0 USDT equity, no open positions**. The account
  is not funded yet. Do not start the live engine until the trading account has
  at least 300 USDT equivalent; the planned starting amount is **320 USDT**.
- Current account position mode is `long_short_mode`, while AlphaGate's runtime
  configuration expects `net_mode`. After funding, confirm there are still no
  positions/orders and obtain explicit approval before changing this account
  setting.
- Current services: `oddsdesk-demo.service` is enabled and active;
  `oddsdesk-engine.service` is not installed; the A2A publisher is active.
- Demo deployment was updated and verified at commit **`43ed72b`** after the
  breadth audit and risk decision. VPS typecheck, build, all **457 tests**, and
  the demo-environment balance guard passed. `oddsdesk-demo.service` is active
  with 1% risk in every stage. This is still simulated trading; no live order
  or real-fund action was performed.
- During that deployment, the old demo process acknowledged SIGTERM but its
  active dual-venue scan exceeded systemd's default 90-second stop timeout and
  was force-killed. Both demo and live unit templates now allow 300 seconds for
  the engine's existing "finish current cycle" shutdown path. The live unit
  also carries the IPv4 DNS setting directly, rather than relying only on an
  environment file.
- `npm ci` reports five dependency advisories (3 moderate, 1 high, 1 critical).
  Do not run `npm audit fix --force` during cutover: it may introduce breaking
  dependency changes. Audit and upgrade them separately with the full suite.

### Resume after funding

1. Re-run the live balance, account-config, orders, and positions checks using
   profile `okx-sub` with IPv4 forced. Confirm at least 300 USDT equivalent is
   in the **trading** account, not merely the funding account.
2. If the account remains empty of positions and orders, ask for confirmation
   and switch the position mode from `long_short_mode` to `net_mode`.
3. Deploy the current reviewed repository to `/opt/oddsdesk`, install a live
   environment that contains only the `okx-sub` credential profile, and include
   the IPv4 `NODE_OPTIONS` setting. Do not expose or copy credentials into chat.
4. Install `oddsdesk-engine.service`, run a stopped/dry live preflight, and
   verify the runtime profile records the observed venue-held stop custody and
   leverage ceiling.
5. Stop and disable the demo service only when the live preflight passes; then
   enable/start the live engine and verify its heartbeat, A2A publication, and
   first valid USDT-perpetual trade.

**Operator resume phrase:** after funding, say `AlphaGate is funded; continue
the live cutover from HANDOFF.md`. The first action is read-only verification,
not starting the engine.

## 2026-08-10 — breadth hypothesis audit and risk decision

- Stage risk is now fixed at **1% in all three stages**. The frozen strategy's
  exact-cost edge is regime-dependent; account growth is not evidence that the
  edge strengthened, so Stage 2 no longer jumps from 1% to 3%.
- A predeclared research gate tested whether short continuation improves when
  dual-venue bearish breadth across the six majors is greater than exactly
  eight hours earlier. The live strategy was not changed before seeing the
  result.
- The expanding-breadth rerun produced 73 pooled trades, +10.9R and PF 1.20.
  Hit rate improved in 4/5 folds, but only 3/5 folds had positive net R, the
  sample missed the 100-trade floor, and gross wins were too concentrated by
  fold. Decision: **REJECT**. Do not add the expanding-breadth gate to live
  trading or tune the lookback after seeing this result.
- The audit is reproducible with:

  ```text
  npm run continuation-breadth-audit -- var/backtest/majors-540d-exact.json
  ```

**Last updated:** 2026-08-10 (session 8 — ASP submission and persistent A2A daemon,
the demo-test boundary; previous session covered exit publication, the competition
clock, directional cap, funding as a cost, Part X, E7 and Part VIII)
**Competition:** OKX.AI Hackathon Season 1
**Registration closes:** Aug 11 12:00 UTC+8 — **the only irreversible deadline**
**Trading window:** Aug 11 12:00 → Aug 25 12:00 UTC+8
**Accounting basis:** Agent Trade Kit, USDT perpetuals. Chosen, irreversible.

---

## 0. The two halves — read this if nothing else

Naming, because it has caused confusion: the **repo** is `oddsdesk`; the
**product** is **AlphaGate**, which is the name of the *signal service* we
publish through. That name comes from build spec Part IV. ASP identity **#10706**
now exists with that name and is under marketplace review.

This competition has two halves and they are not independent.

**Half one — the trading brain.** Fund a sub-account with 320 USDT and trade
USDT perpetuals for two weeks. Best combined return wins. This is the scanner,
the entry and exit rules, the risk limits. **Built and tested.**

**Half two — the publishing service (the ASP).** OKX does not let you simply
trade. You must publish every trade as a *signal* through a service other people
could subscribe to, and OKX checks your real trades against those published
signals. If they do not correspond, the ranking does not count. **The ASP is
created and submitted for review; the persistent A2A daemon is online. The
trading engine is not yet deployed or started.**

**They are wired together deliberately.** The executor's input is published
signal *text*, not an internal decision object, so no order can reach the venue
without having been published first. That makes Law 6 structural rather than a
promise — and it also means the finished trading brain remains **complete and
idle** until the VPS runtime profile and live engine service are installed.

## 0b. Session 8 — exact stopping point

### ASP / A2A

- ASP **#10706**, `AlphaGate`, was created successfully.
- Its reviewed service is `Perpetual Momentum Signals`, A2A, **15 USDT/month**,
  **3-day trial**, with the approved avatar and the exact structured description
  in `config/asp-registration.yaml`.
- Review submission succeeded. Current status: **Listing under review**;
  approval status 2. It is online and has a recent heartbeat.
- On the Lightsail VPS, `okx-a2a.service` is **active** and **enabled** under
  systemd user services. `loginctl enable-linger ubuntu` is enabled, so it
  survives SSH disconnects and reboots.
- Codex CLI 0.147.0 is installed and authenticated on the VPS as the A2A
  provider. `okx-a2a doctor`: 7 pass, 0 fail, 1 readiness warning while the
  daemon warms; the service subsequently reported active and running.

### Trading / stop-custody gate

- **No live or demo order has ever been placed.** No real funds have been
  touched.
- The user selected a minimum-size live kill test, then asked about the demo
  alternative. Current safe next step is the **demo API profile**; do not use
  live money for the kill test until the user re-confirms after understanding
  the risk.
- VPS `okx` profiles currently include `okx-prod` and `okx-sub`; both are live.
  No demo profile exists. Credentials must never be copied into chat or into
  the `oddsdesk` service account without an explicit credential-handling plan.
- `/opt/oddsdesk/config/runtime-profile.tradekit.yaml` is **missing**.
  Stop custody is therefore unverified, and `execution.maxLeverage` must remain
  unset. Do not start the live engine before the stop test records one of:
  `venue-held` → cap 5; `client-held` → cap 2 plus watchdog and pyramiding off;
  `none` → do not trade.
- `/etc/oddsdesk/engine.env` and the `oddsdesk` systemd units are not installed
  on the VPS. The remote `/opt/oddsdesk` checkout is still at `ab30fad`; deploy
  the current repository before installing the engine/watchdog units.

### Next handoff actions

1. In OKX: **Trade → Demo Trading → Personal Center → Demo Trading API**; create
   a separate Read + Trade demo key, with Withdraw disabled and the VPS IPv4
   bound. Configure it directly on the VPS with `okx config init` as profile
   `okx-demo`; never send the three credentials in chat.
2. Run the minimum-size demo stop kill test: open isolated perp, attach stop,
   kill the trading process, inspect the venue, reboot/inspect again, and close
   the test position. Record the observed custody in the runtime profile.
3. Fast-forward `/opt/oddsdesk` to the current pushed commit, install the
   engine/watchdog units and a redacted environment file with
   `OKX_ASP_AGENT_ID=10706`; keep the engine stopped until the profile passes.
4. Run a dry cycle, then perform the live runtime preflight and fund the
   competition sub-account with the planned 320 USDT. The competition clock
   opens **2026-08-11 12:00 UTC+8**.

### Trading half — what works, and what has never run

Verified against live OKX on 2026-08-09 (second run, after session 7's changes):
423 instruments in → **89 passed E1** → 16 reached the regime gate → 9 passed →
11 reached the entry gate → **2 signals** (PNUT, MOODENG, both long).

> **An earlier version of this section said "5 signals" and §5 said "1".** Both
> were describing E2 survivors, not signals. Recorded because the discrepancy
> was load-bearing: it made the correlation problem look like a single-cycle
> event when it is actually a serial one that accumulates over days.

Built and tested (**425 tests**): E1 universe filter (liquidity **and
affordability**) · E2 regime gate (stands down in chop) · E3 volatility-adjusted
momentum ranking · E4 breakout entry with a conviction gate at 75 and **funding
charged into the target** · E5 exits (2×ATR stop, 25% off at +2R, breakeven,
3×ATR Chandelier trail tightening to 2.5× past +4R, 12h time stop, 4h cooldown,
**Part X endgame**) · sizing with no override path · portfolio heat cap ·
**directional cap** · drawdown governor · kill switch · hash-chained append-only
ledger · Trade Kit adapter · copy executor · engine loop · driver ·
**entry AND exit signal publication** · **competition start gate** ·
**E7 fee budget (fees measured, funding modelled)** · **Part VIII attribution** ·
**E6 pyramiding**.

**It cannot place a single order, by design.** `execution.maxLeverage` is unset
and `computeSize()` throws rather than defaulting. It stays that way until the
Part IX stop kill test is observed. **Nothing here has touched real money** —
and per Law 7, a safety mechanism that has never fired in a test does not exist.

**The trading side is now code-complete.** Every config value is read by code —
no dead thresholds, nothing that reads as a control while doing nothing. What
remains is external: the ASP publisher, the leaderboard parser (Aug 11 only),
funding read from venue bills rather than modelled, and the Part IX kill test.

## 0a. Session 7 — ten defects found by review, and what was done

None of these were in the previous handoff. They were found by reading the code
against the rules rather than against the build spec, which is why the spec's
own checklist did not catch them. Ordered as they were ranked: by what costs
money or eligibility.

**1. Exits were trades, and no exit was published.** `loop.ts` called
`flatten()` and wrote a ledger row; `publisher` appeared only in the entry path.
Roughly half of all fills are exits, so half the book had no corresponding
signal, and a subscriber on auto-copy was told to open and never told to close.

*Fixed, with the ordering deliberately INVERTED from an entry.* An entry
publishes and trades only if delivery succeeded. An exit **executes first, then
publishes**, and a publish failure is an alert, never a refusal — gating a close
on the ASP being reachable would mean a dead publisher leaves us holding a loser
we are not allowed to cut. There is a test named for it in capitals.

**2. The venue take-profit contradicted E5.** Found while fixing #1. The entry
order attached a TP at the 3:1 target, but **E5 has no target logic at all** — it
scales 25% at +2R and trails the rest. The venue would have closed a winner in
full at 3R, amputating the tail the strategy exists to capture, and the next
reconcile would have found a phantom position and tripped the kill switch.

*Fixed:* no attached take-profit. The stop stays attached — it is the one order
that must survive us.

**3. The correlation grouping defeated the heat cap.** Every unlisted symbol got
its own bucket, so the memecoin complex — where E3's extremes actually live, and
where nothing is hand-classified — satisfied a cap of two five times over.

*Fixed:* one shared `HIGHBETA_ALT` group, plus a portfolio-wide
`maxPositionsPerSide: 2`. With 3 slots, the third position must now disagree with
the first two or not exist. This **reverses** an earlier decision that was right
in the abstract and wrong at 320 USDT; the reasoning is recorded in the config.

**4. Published leverage had no correct value.** *Fixed, and cheaper than it
looked:* `notionalUsdt / equity` **is** `sizePercent`. Both are published, and
`validateSignal` asserts they agree, so a drift between the two formatters is
caught at the gate. We publish the emergent 0.5–2x, never a nominal 3x.

**5. Nothing stopped the engine trading before Aug 11 12:00.** *Fixed:*
`competition.startsAt/endsAt` in config, parsed to epoch ms at load with a
**mandatory timezone offset** — a bare `12:00` would be read as UTC and open the
engine eight hours early. Refusal lives in the engine AND the copy executor.

**6. Part X endgame had no build task.** *Fixed for the half that needs no
leaderboard:* T−48h stop new entries, T−24h close losing and flat positions, hold
winners on a 1.5×ATR trail into the snapshot. The rank-conditional half still
needs the parser that cannot exist until Aug 11 — but the clock does not wait for
it, which is the entire point. DeepSeek went +125% → +4.89% without this.

**7. Funding was gated but never paid.** At the old `maxAdverseFundingRate` of
0.0005 and a 36h hold, an "acceptable" trade paid up to 0.25% of notional against
a 6% budget spread over ~40 trades — 1.7 trades of budget consumed by one
position, while the fee tracker reported 2 bps maker and looked healthy.

*Fixed in two halves.* At entry, expected carry is **charged into the target**,
so an expensive-to-hold instrument needs a bigger move to clear 3:1 rather than
clearing it on gross — visible in the live scan as PNUT 0.025%, MOODENG 0.046%.
The threshold also dropped to 0.0002 as a backstop.

*And the second half, which needed E7 built first:* funding is now **accrued
against the fee budget**. `execution.feeBudgetFraction` was config read by no
code, so "add funding to the fee budget" was not an addition — there was no
budget. `src/fees.ts` now tracks both and halts new entries at 6% of Principal
Base (19.20 USDT).

**The two costs are not the same kind of number, and the code says so
everywhere they appear.** Trading fees are MEASURED, off `detail.feePaid` on
`order_filled` receipts; an unreported fee counts as zero rather than as an
estimate. Funding is MODELLED, accrued at the venue's real wall-clock funding
timestamps — the adapter cannot read venue bills, so this is an approximation of
a real cash flow, and a far better one than the zero assumed before. Replace it
with bills when the adapter learns to read them.

**8. minSz was never counted. ANSWERED — it is a non-issue.** Measured against
live OKX: **0 of 423 live USDT perps have a minimum order above $60.** The
largest inside the universe is UB at $13.20; the median is $0.43. Breadth is
real. The affordability filter was built anyway and drops nothing today — it is
a guard against a future listing, not a current constraint. E1 now reports its
rejections by reason so this question never needs asking twice.

**9. Rule 9 "risk tokens" — STILL OPEN, and it is yours to close.** See §6.

**10. No expectancy evidence.** Not fixable, and not attempted. See §1b.

### Also built, from the pre-existing list rather than the review

- **E7 fee discipline** (`src/fees.ts`) — see #7 above. Halts new entries on
  breach, never exits: fees are the price of taking positions, so the response
  to spending the budget is to stop taking them, not to abandon the ones already
  paid for.
- **Part VIII daily attribution** (`src/attribution.ts`) — hit rate, average R
  won and lost, **realised payoff ratio**, per-instrument R, all computed from
  the hash-chained ledger rather than from live state, so the report survives the
  restart after the crash you most want explained.

  It measures **terminal closes only**. Counting a +2R scale-out would fill the
  sample with guaranteed winners taken at a fixed multiple and report the exit
  system as healthy precisely *because* it takes profits early — the failure the
  ratio exists to detect. And it returns **null, never Infinity**, when there are
  no losses yet: an untested denominator is not a passing grade. "Not enough
  evidence" is a distinct verdict from "healthy", because conflating them is how
  a strategy gets changed on nine trades.

Everything above is tested. The suite went from 292 to **425**.

---

## 1. Where things stand in one paragraph

The venue-agnostic core is built and tested (**292 tests, typecheck clean**).
The whole signal path — E1 through E5 — is now complete and tested, and
`scan.ts` runs it end to end against the live OKX venue and prints real entry
candidates with bands, stops, targets and conviction breakdowns. The publication
gate (`validateSignal`) is built. Credentials are installed on the box and the
order path is verified to reach the venue's margin check. Nothing can place a
live order yet, by design: `maxLeverage` is unset until the stop kill test is
observed, and `computeSize()` refuses to produce a position while it is unset.
The execution half is built too — the **Trade Kit adapter** over the `okx` CLI
and the **copy executor** — the **engine loop** joins them, and the **driver**
now runs the whole thing on a timer. `run-engine.ts` assembles every component
and executes end to end against the live venue; in this dev environment it stops
at the credential check, which is where it should stop. The one remaining
placeholder in the running path is the **ASP publisher**, which throws rather
than no-ops. What else remains is hardening, the leaderboard parser (Aug 11
only), and the live verification `maxLeverage` depends on. The two things
blocking progress are still external: funding the sub-account, and registering
the ASP.

**Time check:** registration closes Aug 11 12:00 UTC+8, so it is now **~2 days
out** and the practical deadline for starting is roughly **Aug 10 midday**
(the ASP needs ~24h of review with the service online throughout). Everything in
section 6 can be built in parallel; registration cannot be started late. This is
the one thing that cannot be recovered by working harder later.

---

## 1b. What the test suite does NOT establish — read before trusting the green

356 tests pass. **None of them establish that the strategy makes money.**

They pin *properties*: that a bar cannot break its own level, that a stop never
widens, that a touch is not a break, that leverage and size agree, that an exit
publishes even when the publisher is down. That is the correct thing to test and
it is worth what it costs. It is not evidence of an edge.

Specifically, and stated plainly so nobody has to infer it:

- **Stage 7's acceptance test has not run.** No 48h paper run, no realised payoff
  ratio, no measured win rate. `attribution.minRealisedPayoffRatio` is config
  read by no code — the same status as E6 and E7.
- **There is no backtest.** Not a weak one; none. The parameters (conviction 75,
  2×ATR stops, +2R scale-out, 3:1 minimum) come from the spec's reading of Alpha
  Arena Season 1 results, not from anything measured on this data by this code.
- **There is not time to fix this before Aug 11**, and attempting it would cost
  the ASP deadline, which is the one thing that cannot be recovered.

**What is actually carrying the account is the risk architecture** — fixed
fractional sizing with no override path, the heat cap, the directional cap, the
drawdown governor, mechanical exits, the kill switch. That is a defensible thing
to enter a competition on. It is not the same thing as a validated edge, and a
green suite should never be read as one.

**The cheap thing that helps:** run `scan.ts` hourly for a day and count. Target
is ~2/day. Three observed runs so far produced 1, 5 (E2 survivors, not signals)
and 2 signals. If the true rate is 15/day, `minConviction: 75` is too loose and
we overtrade into fees — the exact failure that killed Gemini and GPT-5. That is
a one-line config change, and it is much cheaper to make before go-live.

## 1a. The two documents in `docs/`

| Document | What it is |
|---|---|
| **[`docs/BUILD-SPEC-v2.md`](docs/BUILD-SPEC-v2.md)** | The **governing document**, stored verbatim so it never has to be pasted into a session again. |
| **[`docs/asp-and-competition.md`](docs/asp-and-competition.md)** | The **annex**: exact source quotes from the event page and OKX dev portal (2026-08-09), marked verbatim vs. our reading, plus §9 — the gaps found in the spec. |

Two things the annex corrects that were wrong in earlier sessions:

- **The ASP is built, deployed and listed BEFORE it is registered**, and
  competition entry is a *separate second gate* after ASP approval.
- **The service is A2A monthly subscription**, so no public HTTPS endpoint is
  required — and exactly one subscription service may exist, never deleted.

### Gaps found in the build spec

Full detail in the annex §9. Three of these block registration outright.

**Blocks registration (two, not three — see the correction below):**

1. **The name is too long for both fields.** `AlphaGate — Perpetual Momentum
   Signals` is **38 chars**; agent name caps at EN 3–25, service name at 5–30.
   Split: agent `AlphaGate` (9) + service `Perpetual Momentum Signals` (26).
   Safe, because the classifier reads name + title + description concatenated,
   so the mandatory `Perpetual` keyword still lands.
2. **An avatar is mandatory and the spec never mentions one.** An uploaded image
   file ≤1 MB. Links rejected, no default for the ASP role. We have none.
**Not a blocker — corrected.** Earlier notes claimed "one ASP per wallet".
That is the rule for the *user* and *evaluator* roles, not ASP. The pre-check's
`canCreate:true` branch explicitly handles "ASP role with existing ASPs (K >= 1)"
and offers *1. New ASP / 2. Update #N*, and it returns a dedicated `aspCount`
field. A second ASP is a supported choice, and even in the restricted case the
consequence is a redirect to update, never a refusal.

The real one-per-wallet-style constraint is a different thing entirely and is
already recorded: competition rule 3.3 requires exactly **one subscription
service**, earliest-created wins, never delete it.

**Missing infrastructure:**

4. **`onchainos` and `okx-a2a` are not in spec Part XII** but the delivery
   daemon shells out to both. Install: `npx skills add okx/onchainos-skills --yes -g`.
5. **Agentic Wallet login is email + browser, on a headless box.** The daemon
   emits a login URL to complete in a browser then polls. Recurs on every JWT
   expiry — which is Trap 4.
6. **Four processes on a 2 GB box.** Part XII caps three units at 1.25 GB, but
   the Python daemon is a fourth with no cap, and `delphi-agent` is an unrelated
   project on the same box.

**Missing integration:**

7. **How the signal engine reaches the daemon is unspecified.** Engine is
   TypeScript, daemon is Python. Either the engine writes `signals.txt` for
   `asp_push.py`, or it shells `onchainos agent deliver` itself. This is the
   `SignalPublisher` implementation — the last placeholder in running code.
   Part IV mandates *scheduled* push for the 45 s heartbeat while our engine is
   event-driven, so likely both: autopilot for heartbeat, engine for delivery.
8. **Self-subscription is now an explicit deployment gate.** The previous
   handoff omitted it even though Part III and tutorial step 5 require a
   separate buyer session for copy trading. On 2026-08-11 the VPS resolved
   buyer User `#10743` and created a 72-hour AlphaGate trial with auto-renew
   disabled. The first attempt stopped before signing/broadcast because the
   Agentic Wallet had no 15 USDT on XLayer; after funding, the retry succeeded.
   The resulting buyer subscription is
   `0xd516a15c5778418e649717c18211a94becea9db9a691da7f3e644d2a6a9457d8`.
   The provider-side active subscriber is a different buyer and has
   `copyTrade=0`, so it does not describe this buyer route.
9. **Competition registration is a second gate** after ASP approval — bind the
   OKX UID, fund ≥300 USDT. Part XIII says only "register early".

**Smaller:** the spec's `classify()` table omits `option` and
`defi|liquidity|lp`; the free trial is fixed at exactly 72 h; the fee must be a
quoted digits-only string (`"15"`, never `15 USDT`); prizes run 4th–40th at $500
each; rule 3.2 requires the service to stay usable **by other subscribers**.

### Where our build diverged from the spec

10. ~~**`formatSignal` does not match the spec's canonical shape.**~~ **Fixed in
    session 7**, with three deviations kept deliberately. Current output:

    ```
    [Perpetual Signal] BTC-USDT-SWAP | LONG 0.4x | Entry 64700-64800 | SL 64000 | TP1 66400 | TP2 67200 | Position 40% | Valid 2026-08-12T13:00Z | S-260812090000-BTC-L
    ```

    Decisions made, each cheap to overturn if you disagree:

    - **`-USDT-SWAP`, not `-PERP`.** It is the instId Trade Kit places against,
      and Law 6 is that published equals placed. A subscriber maps one name;
      publishing an instrument we do not trade inverts the law. *(The ASP
      classifier reads name/title/description, not the signal body, so the
      mandatory `Perpetual` keyword is unaffected either way.)*
    - **The signal id stays in the text.** The spec's field list omits it, but
      Law 6 requires traceability *from logs*, and the alternative — keying on
      the delivery `jobId` — cannot be built until the publisher exists. 24
      characters is cheap for traceability that does not depend on an unbuilt
      component. Revisit once the publisher is real.
    - **Absolute expiry, not "Valid for 6h".** A duration means one thing to the
      publisher and another to a reader forty minutes later. Same reasoning as
      absolute prices.

    And one addition the spec does not have: **TP1 and TP2 are different
    events.** TP1 is where 25% actually comes off at +2R; TP2 is the screening
    target the trail may or may not reach. Publishing one number and calling it
    the plan is what made the old signal describe a trade we never took.

11. **The build order was not followed.** Part XIII puts the ASP at stage 2,
    *before* the Trade Kit adapter at stage 3, precisely because of the deadline.
    We built 3, 5, 6, 7 and have not started 1 or 2.

## 2. Decisions already made (do not relitigate without reason)

| Decision | Value | Why |
|---|---|---|
| ASP service type | **A2A, monthly subscription** | Rule 3.3 requires one subscription service as the scoring basis. A2A needs no endpoint, so listing is not blocked on a public HTTPS deployment. Details in `docs/asp-and-competition.md` §2. |
| Accounting basis | **Agent Trade Kit** (USDT perps) | Rule 5: one basis, chosen at registration, cannot change. Onchain OS was abandoned when Polymarket blocked Ireland. |
| Trading account | **Sub-account**, not main | Main account is level 1 (Spot mode) and rejects perps with `sCode 51010`. Sub-account is level 2 (Futures mode). Also keeps existing balances out of the Principal Base denominator. |
| Margin mode | **Isolated** | Cross lets one bad position consume the equity backing every other. |
| Position mode | `long_short_mode` (hedge) | Matches what the account already had; code handles either. |
| Egress | **Pinned to IPv4** | The box egresses IPv6 by default; the API key whitelists an IPv4 address. Pinned rather than whitelisting the v6 address, because a rotating SLAAC address would fail silently later. |
| Polymarket / Onchain OS | **Abandoned** | Ireland added to Polymarket's restricted jurisdictions 21 Jul 2026 (GRAI enforcement). Not a technical blocker — regulatory. |

---

## 3. Access and credentials

**Box:** AWS Lightsail, Ireland (`eu-west-1`), 2 GB / 2 vCPU, Ubuntu 24.04
**IP:** `54.154.121.30` (static)
**SSH:** key installed for `ubuntu@54.154.121.30`; private key at `~/.ssh/oddsdesk_ed25519` in the dev environment

**OKX CLI profiles on the box** (`~/.okx/config.toml`):

| Profile | UID | Level | Use |
|---|---|---|---|
| `okx-prod` | `230732502594105344` | 1 (Spot) | Main account. Never traded. Retained for comparison. |
| `okx-sub` | `872206075171601774` | 2 (Futures) | **The competition account.** All trading. |

Every CLI call needs both of these or it will fail confusingly:

```bash
export PATH=$HOME/.npm-global/bin:$PATH
export NODE_OPTIONS=--dns-result-order=ipv4first   # or the API key IP whitelist 401s
okx --profile okx-sub account balance
```

Both are appended to `~/.bashrc` on the box already.

---

## 4. Verified facts (measured, never assumed — Law 1)

Recorded in `config/runtime-profile.tradekit.yaml` (gitignored — machine-local).

| Fact | Value | How it was established |
|---|---|---|
| Fee tier | Lv1 — **maker 2 bps, taker 5 bps** | `okx account fees --instType SWAP` |
| Universe | **423 live USDT perps** | `/api/v5/public/instruments`. An earlier reading of "35" was the CLI's display page limit — wrong. |
| Universe contents | Includes tokenised equities (AAPL, NVDA, TSLA) and commodities (XAU, XAG) | Excluded by explicit symbol list — they gap across traditional market hours and break ATR/breakout logic |
| API key instrument scope | **All** perps, no whitelist | Filtering stays in code where it can adapt |
| Order path | **Reaches the margin check** | Probe returned `sCode 51008` (insufficient balance) on the sub-account vs `51010` (account mode) on main |
| Attached TP/SL | Exposed on `swap place` | `--slTriggerPx`, `--tpTriggerPx`, trigger types `last\|index\|mark` |
| Native trailing stop | Exposed | `okx swap algo trail --callbackRatio` — maps onto the Chandelier exit, no client-side synthesis needed |
| Demo mode | **Needs its own API key** | Live key returns `APIKey does not match current environment` |
| **Stop custody** | **UNVERIFIED** | The presence of `--slTriggerPx` is *not* proof the stop rests on the venue. Kill test not yet run. |

---

## 5. What is built

All under `/workspaces/oddsdesk` on **`main`**. 425 tests passing.

**One branch, deliberately.** Sessions 1-6 left a `core-risk-ledger` branch and
session 7 left a `session-7-review-fixes` branch; both were fully merged
duplicates of `main` and have been deleted. With a two-week competition and one
operator there is nothing a second branch buys, and a stale branch that still
looks like the place work happens is how a fix gets made twice or lost once.

### `src/config.ts` + `config/default.yaml`
Zod-validated policy loader, strict, no default-on-missing. Policy only —
venue facts live in the runtime profile.

- `requireMaxLeverage()` is the **only** accessor for leverage and throws while
  unset. This is what makes "unverified stops cannot reach a leveraged book" a
  structural property rather than a promise.
- `assertIsolatedMargin()` refuses cross margin.
- Schema refinements reject a pyramid ladder that doesn't strictly decrease and
  a trail that tightens before the scale-out.

### `src/ledger.ts`
Append-only hash-chained SQLite. Append-only enforced by **database triggers**,
so a hand-typed `UPDATE` fails too. `verifyChain()` recomputes the chain and
detects edited or deleted rows. Refusals are first-class entries.

### `src/kill-switch.ts`
File-backed, scoped, survives restart, **fails closed** on a corrupted file.
`assertClear()` throws rather than returning a boolean a caller can ignore.

### `src/risk.ts`
- One sizing function, no override parameter (a test asserts its arity).
- Risk is a fixed fraction of equity per stage; **notional is derived** from stop
  distance; **leverage is an output** checked against a cap.
- Refuses on: payoff ratio < 3:1, stop on the wrong side, 4th concurrent
  position, 3rd position in a correlation group, portfolio heat > 6%, governor
  halt, below eligibility floor, adding to a loser.
- Drawdown governor measures from **peak**, stage-aware.

### `src/execution/adapter.ts` + `guarded.ts`
Engines hold `GuardedExecutor`, never an adapter, so no order can skip a gate.
Order: kill switch → feed staleness → risk-token gate → stop requirement →
ledger receipt → venue call.

- Receipt is written **before** submission, so an order lost to a timeout still
  leaves a trace.
- A leveraged fill returning without a resting stop **trips the kill switch**.
- Reconciliation halts on divergence rather than attempting a repair.
- `flatten()` deliberately bypasses the kill switch — closing risk must stay
  available after every other gate has shut.

### `src/rank/steering.ts`
Both score axes ranked separately, gaps to the podium, binding axis, attrition
rate. Out-of-range ranks return `null`, not `0`. Not finding ourselves raises.
Stage 3 cushion is measured against **rank 4** (whoever would displace us) and
requires both axes. Stale snapshot returns `null` so Stage 3 stays unreachable.

**`parseLeaderboard()` throws `ParserNotBuilt`** — the page does not exist until
Aug 11. Snapshots retain raw HTML for replay.

### `src/market/okx.ts`
Read-only public data client. Strict parsing (OKX returns numbers as strings and
`''` coerces to 0). Checks the envelope `code`, not just HTTP status. Candles
reversed to chronological order; **unconfirmed bar dropped** (it repaints).
Request pacing through a chained gate + backoff on 429/5xx.

### `src/signal/indicators.ts`
Wilder recursion for ATR and ADX (not an EMA approximation — different series).
Realised volatility, ATR-normalised momentum, volume trend, breakout levels that
**exclude the current bar**. Everything throws on short history.

### `src/signal/scanner.ts`
E1 universe filter, E2 regime gate, E3 cross-sectional ranking. Regime gate runs
before ranking is acted on, so chop is never ranked against trend. Extremes
taken disjointly so a small universe can't produce a simultaneous long+short.

### `src/signal/exits.ts` — E5, complete (31 tests)
Pure function of position state and market state returning decisions the
executor carries out. No venue needed, so the whole exit path is exhaustively
tested.

- **`ratchetStop()` returns the existing stop when asked to widen.** "Never move
  a stop away from price" is a move the code cannot make, not a rule it follows.
- **Chandelier anchors to the extreme since entry**, not current price —
  anchoring to price would loosen the stop on every pullback.
- **R is anchored to the initial stop.** Measuring against the current stop
  would divide by zero at breakeven and inflate every R multiple before that.
  This matters: R is the metric the daily attribution uses to detect broken
  exits, so an inflated R would hide the very failure it exists to catch.
- Evaluation order is fixed, first terminal action wins: stop hit → time stop →
  scale-out → breakeven → trail. A losing position yields nothing but `hold`.
- 25% off at +2R (not 50%) so three-quarters of the tail survives; breakeven at
  the same point; trail 3× ATR tightening to 2.5× past +4R; time stop at 12h
  without +1R; 4h cooldown after a stop-out.

The key test walks a position from entry through +5R and back through a
pullback, feeding each plan's stop into the next step, asserting the stop never
widens at any point.

### `src/signal/entry.ts` — E4, complete (24 tests)

Breakout of the N-period extreme on the confirmed 1h bar, plus a 0–100
composite conviction score gated at 75.

- Conviction components (momentum rank, ADX above the regime floor, volume
  expansion, 4h agreement) each **saturate**, so one extreme reading cannot drag
  a mediocre candidate over the line on its own.
- Entry is a **limit band** in ATR units, not a market order — maker is 2 bps
  against taker 5 bps (measured), and chasing gives that edge away.
- Target is **derived from the stop** at the minimum payoff ratio, so a signal
  cannot exist without a 3:1 target.
- Rejections carry **every** reason, not the first — the daily attribution needs
  to see whether the gate rejects for one dominant cause, which is how you learn
  the threshold is misplaced.
- Conviction never touches size (Law 9).

The tests pin the properties the module exists to guarantee, not its output: a
bar cannot break its own level, a touch is not a break, each conviction
component saturates, rejections carry every reason, the target sits at exactly
the minimum payoff ratio, and the band brackets the level on the correct side
for both directions.

### `src/signal/publish.ts` — publication gate, complete (32 tests)
The published text is the **authoritative record** of a trade (Law 6), not a
summary of one — the copy executor parses these numbers and acts on them.

- The plan is **rounded to publishable precision first**, then formatted, then
  validated against that same rounded plan. What we publish and what we place
  are identical by construction, not by two code paths agreeing.
- `validateSignal()` returns **every** failure: exact header prefix, 200-char
  limit, live instrument, traceable id, all four prices present as absolute
  decimals, no relative-price language, size as a percentage, stop/target
  geometry, and the payoff ratio **re-checked against the rounded numbers**
  (rounding can shave it, and the achievable ratio is the published one).
- `buildSignal()` **throws** rather than returning an invalid signal, so no
  caller can publish one by ignoring a return value.
- `SignalCycle` enforces `generated == delivered + rejected`. This catches the
  one failure with no other trace: a signal dropped by an early return or a
  swallowed exception, where the only evidence is an absence.
- `formatPrice` trims trailing zeros **only inside the fraction**. Trimming
  unconditionally turned `118000` into `118` — a price three orders of magnitude
  wrong that still looks like a price. There is a test.

### `src/execution/tradekit.ts` — Route B adapter, complete (45 tests)
`ExecutionAdapter` over the `okx` CLI. Shaped by CLI behaviour measured on
2026-08-09, not by its documentation: with `--json` stdout is the bare `data`
payload and the update banner goes to stderr; a failure exits non-zero and
leaves stdout empty, so **exit code is the error signal**.

- Money crosses the boundary as exact decimal strings converted to bigint minor
  units. Never via `Number`: `0.07 * 1e8` is `7000000.000000001`, and a size
  that rounds up is a size the venue rejects or fills larger than intended.
  Excess precision **throws** rather than truncating a venue value.
- `submitOrder` **refuses while stop custody is `unverified`**. `flatten` does
  not — closing risk must outlive every other gate.
- A `sCode` rejection inside an exit-0 response is reported as `rejected`.
  Treating exit 0 as success would report a rejected order as accepted.
- `stopResting` is **never claimed from the placement response**. `swap place`
  acknowledges the order, not the attached algo; only `openPositions()`, which
  reads the algo book back, can answer it. Claiming it would defeat the
  GuardedExecutor check that trips the kill switch on a naked fill.
- Resting stops are keyed by **instrument and side**. Hedge mode allows a long
  and a short on one instId, and keying by instId alone reports the short's stop
  as the long's — a naked position that looks protected.
- `flatten` passes `--autoCxl`: a stop left behind on a flat position opens a
  NEW position when it fires.
- Sizes are in **contracts**, so `Instrument` now carries `contractValue`
  (`ctVal`), required and explicitly nullable. On BTC-USDT-SWAP that multiplier
  is 0.01 — sizing in coins would be a hundredfold error the venue accepts.

### `src/execution/copy.ts` — copy executor, complete (28 tests)
Deliberately the dumbest process in the system. Law 6 is only structurally true
if the thing that places orders cannot form an opinion, so this module has **no
strategy logic and no discretion**.

- `parseSignal` is the **exact inverse of `formatSignal`**, pinned by a
  round-trip test, and rigid: an unparseable body is a refusal, never a fallback
  to a market order at a price nobody published.
- The **publication gate is re-run on read-back**. The text checks pass
  tautologically, but the geometry and payoff checks do not — that is what makes
  an altered signal refused at the executor rather than traded on trust.
- `requireMaxLeverage()` is consulted **here as well as upstream**, so an
  executor pointed at a config whose Part IX verification has not been done
  trades nothing at all. The refusal does not live in only one place.
- The limit price is the **far edge of the published band** — the worst price
  inside it. A limit fills there or better, so the band is honoured exactly and
  a fill outside what was published is impossible.
- Size **rounds down, never up**: rounding up spends more than the published
  percentage said. Float error is settled before the floor, or an exact 0.24
  contracts silently becomes 0.23.
- The signal is journalled **before** submission. An order lost to a timeout
  must not be retried on the next delivery — the venue may well hold it.
- Every path returns a tagged `ExecutionOutcome`, so a signal that was not
  traded is distinguishable from one that was never seen.

### `src/engine/state.ts` — durable engine state
The three things that are inherently temporal and cannot live in a pure
function, all surviving restart, written atomically via rename:

- **Cooldowns.** E4 accepts a `cooldownUntilMs` but cannot know it. A cooldown
  that resets on restart is an invitation to re-enter the instrument that just
  stopped us out, exactly when a crash makes a restart likely.
- **Position history** — entry, ORIGINAL stop, extreme since entry, opened-at.
  The venue reports none of these; it knows size and mark, not what R means for
  this trade. Losing the extreme silently loosens every trailing stop back to
  its entry-time value, the one move `ratchetStop` exists to forbid.
- **Peak equity**, so the governor's measurement outlives the process.

A corrupt state file **refuses to start** rather than presenting an empty book —
a cold start must be an explicit decision, never a fallback.
`withObservedPrice` only ever widens the anchors.

### `src/engine/loop.ts` — the engine loop, complete (28 tests)
What it adds is **order**, and the order is the design:

1. Reconcile against the venue.
2. Manage open positions (E5).
3. Check the governor.
4. Only then look for entries — size → publish → execute.

**Steps 1-2 run unconditionally**: kill switch tripped, regime unfavourable,
governor halted, it does not matter. An engine that stops managing its book has
not become safe, it has become an abandoned book. Only step 4 is gated.

- Law 6 runs one way: `computeSize` → `buildSignal` → `publish` →
  `copyExecutor.execute(text)`. The executor receives the **text, never the
  plan**, so no decision can reach the venue without passing through its own
  published record. A signal whose **delivery failed is not traded**.
- `SignalCycle.assertBalanced()` runs in a `finally`, so a mid-cycle throw
  cannot hide a dropped signal — but when the books are straight it must not
  mask the real fault, and a test pins that too.
- Candidates are taken **strongest conviction first**. Slots and heat are
  finite, so consideration order allocates capital; scan order would allocate it
  alphabetically.
- A new position is added to the **running heat within the same cycle**, so the
  second candidate is sized against a book that includes the first.
- The governor is applied in **one place only** — `computeSize` already halves
  the risk fraction, so the loop does not halve it again.
- A position it cannot price **throws**. The alternative is trailing a stop off
  a stale number.

`correlationGroupFor()` and the new `correlationGroups` config make
`maxPositionsPerCorrelationGroup` mean something; an unlisted symbol gets its
own bucket rather than being pooled into a shared "other" that would make two
unrelated small caps count as a correlated pair.

### `src/engine/scan.ts` — the scan pipeline (5 tests)
E1-E4 as a value, so there is exactly **one** implementation of the scan
ordering. `scan.ts` now renders it rather than re-deriving it; two copies would
drift, and the drift would be invisible — the script reporting what the engine
no longer does is worse than having no script.

- **Open positions are priced even when they fall out of E1.** An instrument
  whose volume dries up leaves the universe, but a position in it still has to
  be managed, and the engine refuses to manage a position it cannot price.
  `mustPrice` fetches them explicitly.
- **Feed freshness is measured from when the bar CLOSED**, not when it opened. A
  confirmed 1h bar is up to an hour old by construction; measuring from the open
  makes every healthy feed look an hour stale and refuses every order at the
  guard.
- The **worst** feed is reported, not the average. One instrument stuck on an
  old bar is a stale feed even when the rest are current.
- Cooldowns are passed into E4. The script has none and over-reports by design.

### `src/engine/driver.ts` — the driver (11 tests)
Owns the timer, the process, and the decision to continue after a failure.

- **Cycles never overlap.** `setInterval` would start a second cycle while the
  first is reconciling, and two cycles reading one position book double-size the
  same candidate. The next cycle is scheduled after the previous one finishes.
- **A transient failure is tolerated.** The ASP must never go down; an engine
  that exits on the first HTTP hiccup fails the eligibility requirement it was
  built to satisfy.
- **Three consecutive failures trip the kill switch.** One failure is the venue,
  three in a row is us — and that difference is not visible in any single error,
  only in the pattern. The counter resets after a good cycle, so three failures
  spread over a fortnight do not halt the agent.
- `stop()` finishes the cycle in flight rather than aborting. Interrupting
  mid-cycle can leave a position opened but untracked, the one inconsistency the
  state file cannot repair.

### `src/scripts/run-engine.ts` — the entrypoint
Assembly with no logic; every decision it could make is already made in a tested
module. It adds only the refusals that belong at startup:

- **Stop custody and position mode come from the runtime profile**, never
  literals. A hardcoded `venue-held` would defeat the Part IX gate from outside
  it, which is the one move the gate cannot defend against.
- A custody claim with `killTestObserved: false` is **refused**. A value that
  was not observed is worse than none: it puts an unverified stop mechanism in
  front of a leveraged book while looking verified.
- **`--live` is explicit**; the default is a single dry cycle. An entrypoint
  that trades by default is one mistyped command from trading when someone meant
  to look.
- On halt it exits **non-zero** — the reference daemon's exit-zero-on-JWT-expiry
  trap is not repeated.

```bash
NODE_OPTIONS=--dns-result-order=ipv4first npx tsx src/scripts/run-engine.ts         # dry
NODE_OPTIONS=--dns-result-order=ipv4first npx tsx src/scripts/run-engine.ts --live  # run
```

### `src/scripts/scan.ts`
Live observability tool, now running **E1 → E4**. Run it any time:

```bash
NODE_OPTIONS=--dns-result-order=ipv4first npx tsx src/scripts/scan.ts
```

It prints entry bands, stops, targets and the conviction breakdown for every
candidate that cleared E2, plus a count against `targetTradesPerDay` so an
over-loose threshold is visible rather than inferred.

Last live run (2026-08-09): **79 instruments passed E1** from 423 listed; **5 of
14 extreme candidates passed E2**; regime favourable; **1 entry signal**. The
four rejections were all *no breakout* at conviction 89–100 — the gate holding a
strong-but-untriggered candidate back, which is exactly its job.

It is stateless, so it passes no cooldown. The live engine must.

---

## 6. What is left

### Blocked on you

1. **Fund the sub-account with exactly 320 USDT.**
   Transfer main → sub-account `872206075171601774`. Confirm it reads 320
   *before* registering — Principal Base is initial equity plus **peak net
   deposit**, so a later top-up permanently raises the denominator and damages
   half the score.

2. **An avatar image for the ASP** — required to register, and we have none.
   An image file ≤1 MB, 1:1 square recommended. Links are rejected; there is no
   default for the ASP role. Hard blocker on registration.

3. **Confirm the ASP name split.** The spec's 38-char name fits neither field.
   Proposed: agent `AlphaGate`, service `Perpetual Momentum Signals`. The word
   **"Perpetual" is mandatory** somewhere in name/title/description — without it
   the daemon classifies the service as `text`, which delivers successfully and
   executes nothing.

4. **Ask OKX what "risk tokens" means (rule 9).** One message, and it is the
   highest expected value per minute left in the project.

   The rule says only *"risk tokens are excluded from the PnL% calculation"* and
   **never defines the term** — it is an unknown, not a stated exclusion of
   anything in particular. The build spec dismissed it (*"trading only liquid
   USDT perps sidesteps this entirely"*), which is an assertion in a document
   whose Law 1 is "verify, never assume".

   It matters because our live signals keep being memecoins: BOME, NEIRO, PNUT,
   MOODENG. **Bounded downside**, though — rule 9 excludes them from PnL% only,
   and ranking is 50% PnL% + 50% PnL (rule 6), so the worst case costs half the
   score, not all of it.

   If the answer is "yes, low-cap memes count", the response is a config change,
   not a code change: extend `universe.excludeSymbols`, or raise
   `minQuoteVolume24hUsdt` until the tail drops out. Do **not** build a
   classifier we cannot validate against their definition.

5. **Optional but recommended — a demo API key.**
   OKX → Demo trading → API key (Read + Trade, Perpetual). Then on the box:
   `okx config init`, answer `1`, **`Y`** to demo, profile name `okx-demo`.
   Without it the stop kill test must run on live money.

### Blocked on funding (not on time)

6. **Part IX stop verification — the gate on everything.**
   Open a minimum-size position, attach a stop, `kill -9` the agent, inspect
   from the venue side whether the stop still rests, reboot the box, inspect
   again. Result decides:

   | Outcome | `maxLeverage` |
   |---|---|
   | Venue-held stops confirmed | **5** |
   | Client-held only | **2**, pyramiding disabled, watchdog required |
   | No stop capability | **Do not trade.** Escalate. |

   Until this is observed, `computeSize()` refuses to size anything. That is
   correct and must not be "temporarily" bypassed.

### Buildable now, no funding needed

~~5. Test E4.~~ **Done** — 24 tests.
~~6. Wire E4 into `scan.ts`.~~ **Done** — 1 signal from a 79-instrument
universe, which is the right order of magnitude.
~~7. Signal formatting and `validateSignal()`.~~ **Done** — `src/signal/publish.ts`,
32 tests.

~~8. Trade Kit execution adapter.~~ **Done** — `src/execution/tradekit.ts`,
45 tests.
~~9. Copy executor.~~ **Done** — `src/execution/copy.ts`, 28 tests.
~~12. Wire the engine loop.~~ **Done** — `src/engine/loop.ts` + `state.ts`,
28 tests.

~~Driver and signal journal.~~ **Done** — `src/engine/driver.ts`,
`src/engine/scan.ts`, `EngineState.signalJournal()`, `run-engine.ts`.

**Start here next session:**

**13. The ASP publisher** is now the only placeholder in the running path.
`UnbuiltPublisher` throws by design — a publisher that silently succeeded would
let the engine trade signals nobody received, which reads as a working agent
from every angle except the rules. It cannot be written until the ASP is
registered and its delivery contract is observable, which makes registration the
blocker for code as well as for eligibility.

~~Exit publication, competition clock, directional cap, funding cost, Part X
endgame, E1 affordability, **E7 fee budget**, **Part VIII attribution**.~~
**Done in session 7** — see §0a. 397 tests.

~~E6 pyramiding.~~ **Built** — `src/signal/pyramid.ts`. Arms only in stage 2,
past +2R, with the stop at breakeven or better, on a NEW breakout. Ladder 1.0 ->
0.6 -> 0.4, max 2 adds. An add is **published as an add** (`| ADD 1 |`) rather
than inferred, because the copy executor's refusal to add to a held position is
what stops a redelivered signal doubling it — and because "add to the BTC long
you already have" is a different instruction to a subscriber than "open a BTC
long". The add inherits the **stack-wide stop**, read from state after E5 has
run, so a fresh 2xATR stop can never widen risk across the whole stack.

~~`exits.minHoldHours` dead config.~~ **Wired** — into the attribution, as a
diagnostic. The spec calls 4-36h a *target band* ("both Alpha Arena winners sat
there"), not a rule, so nothing forces an exit at either end; the report now
shows median hold and how many trades fell outside it. Turning a descriptive
band into a forced close would have amputated exactly the winners the whole
design exists to hold.

Remaining unbuilt:

- **Funding from venue bills** rather than modelled. `src/fees.ts` is structured
  for the swap: replace the accrual, keep the budget.
- **Leaderboard parser** and the rank-conditional half of Part X. Aug 11 only.
- **The ASP publisher.** Still the only placeholder in the running path.

Then 10 and 11.

10. **Server hardening** — systemd units with `MemoryMax`, ufw, NTP, alerts,
    pending reboot (`libc6` + kernel update outstanding).
11. **Leaderboard parser** — Aug 11 only, against the real page. Now also
    unlocks the **rank-conditional half of Part X**: the time-conditional half
    is built and runs unconditionally, but "de-risk when leading with cushion,
    concentrate when mid-table because 6th and 20th pay identically" needs a
    live rank. Wire it into `competitionPhase` consumers once the parser exists.
12. **Hourly `scan.ts` frequency count** — cheap, and it is the only evidence
    available before go-live that `minConviction: 75` is set correctly. See §1b.


## 7. Traps already identified — do not rediscover these the hard way

- **`20_000_000` in YAML parses as a string.** YAML has no numeric separators.
  The schema caught it; keep it that way.
- **Instruments in `preopen` state have empty spec fields.** Skip non-live
  instruments; keep strictness for live ones.
- **A universe scan hits HTTP 429 immediately** without pacing.
- **The Lightsail browser terminal wraps long pastes**, corrupting multi-line
  commands. Keep pasted commands short, or assemble long strings on the box.
- **Demo is a separate environment** with separate credentials.
- **ASP classification is keyword-driven** on name/title/description. Assert the
  service maps to `perp` at daemon startup and refuse to start otherwise.
- **`riskUsdt` is an AMOUNT, not a price distance.** Using the raw stop distance
  reads as hundreds of percent of portfolio heat and refuses every subsequent
  trade. `openRiskUsdt()` converts contract minor units through both the lot
  scale and the contract multiplier. There is a test.
- **The governor lives in `computeSize` only.** It halves the risk fraction
  there; halving again in the loop quartered the position while the ledger still
  called it a halve.
- **`minSz` is not checked by the copy executor.** It sizes, then lets the
  venue be the authority on the minimum. A rejection is recorded as a refusal —
  but the signal is already journalled, so it will not be retried. Correct, and
  worth knowing before it looks like a bug.
- **Published prices carry five significant figures**, which can be finer than
  the tick on a cheap perp and coarser than the venue would allow on BTC.
  `priceToMinor` snaps to the tick; the placed price is the published price.
- **The reference delivery daemon exits zero on JWT expiry**, so
  `Restart=always` may not restart it. Exit non-zero, write a liveness file,
  and monitor off-box.
- **A competition timestamp without a timezone offset is eight hours wrong.**
  The schema rejects one, and it must keep doing so. `2026-08-11T12:00:00` reads
  as UTC and opens the engine at 20:00 UTC+8 the day *before* — pre-start fills
  that move equity and do not score.
- **Do NOT make exit publication a precondition for closing.** It is the mirror
  of the entry rule and it looks like an inconsistency worth tidying up. It is
  not: an entry that cannot be published is simply not taken, while an exit that
  cannot be published has already happened, and refusing to close because the
  ASP is unreachable trades unbounded risk for a record. There is a test in
  capitals guarding this.
- **Do NOT re-attach a venue take-profit.** `targetPrice: null` in the copy
  executor is deliberate. E5 owns exits; a venue TP closes the whole position at
  TP2, amputates the tail, and leaves the engine trailing a stop on a position
  that no longer exists until reconcile trips the kill switch.
- **`maxPositionsPerSide` must stay strictly below `maxConcurrentPositions`.**
  The schema enforces it. Equal values permit a fully one-sided book, which is
  the concentration the cap exists to prevent.
- **Funding in the fee budget is MODELLED, not measured.** `src/fees.ts` accrues
  it from the observed rate at the venue's wall-clock funding timestamps, because
  the adapter cannot read venue bills. Trading fees in the same budget ARE
  measured. Do not let the two blur together in a report — every printout names
  which is which, deliberately.
- **Part VIII counts terminal closes only.** Including scale-outs would fill the
  sample with guaranteed +2R winners and report the exit system as healthy
  precisely because it takes profits early — the failure the ratio detects.
- **`regime.fundingWindowHours` is the one assumed number in `config/default.yaml`.**
  Every other value there is policy or measured; this is a venue fact sitting in
  a policy file, unverified. It is 8 for every OKX USDT perp today. Move it to
  the runtime profile when the profile learns to carry it.

---

## 8. Sequence from here

Corrected for the two-gate ordering. The ASP branch starts with deployment, not
with registration.

```
  avatar image ──────┐
  name decision ─────┤
  fix formatSignal ──┼──▶ deploy to VPS ──▶ daemon online ──▶ LIST service
  onchainos+okx-a2a ─┤   (spec stage 1)     (45s heartbeat)         │
  publisher wired ───┘                                              ▼
                                                   ~24h REVIEW, ASP online throughout
                                                                    │
                                                                    ▼
                                                              ASP approved
                                                                    │
  fund sub-account (320) ───────────────────────────────────────────┤
  demo API key (optional) ──────────────────────────────────────────┤
                                                                    ▼
                                         COMPETITION REGISTRATION (bind UID, >=300 USDT)
                                                  deadline Aug 11 12:00 UTC+8
                                                                    │
  stop kill test ──▶ write maxLeverage ──▶ live minimum-size order ──┤
                                                                    ▼
                                          freeze → 24h dry run → Aug 11 12:00 trading opens
```

**Working backwards from the deadline:** competition registration closes
**Aug 11 12:00 UTC+8** and requires an approved ASP. Approval takes ~24h with the
service online throughout. So the service must be **listed and running by roughly
Aug 10 midday UTC+8** — which makes deployment, not code, the binding constraint.

---

## 9. Standing constraints

- **No code path may request a deposit.** Principal Base must never rise.
- **Every trade must trace to a published signal** (Law 6) — signal ID → order
  ID → fill → exit, provable from logs. OKX checks trades against ASP signals.
- **The ASP must never go down.** It is both an eligibility requirement and,
  under v2, the signal source — if it stops publishing, trading stops.
- **Strategy freezes the day before go-live.** After that the only levers are
  risk fraction, engine on/off, and stage.

## 10. Session pause — Lightsail SSH access

The operator has a Lightsail VPS and is logged in as `ubuntu`. A dedicated
Ed25519 key pair was generated for this workspace:

- Private key: `.tmp/lightsail-codex-ed25519` (mode `600`, git-ignored; never
  paste or transmit it)
- Public-key fingerprint:
  `SHA256:hsccVAjCIt6VpnVZg2zqhGfN1PH+T65o/zOJMJIfJYQ`
- Public-key comment: `codex-oddsdesk-lightsail`

The Lightsail browser terminal wrapped the long public key during paste. The
VPS `~/.ssh/authorized_keys` currently contains malformed fragments at least
on lines 10, 13, and 15; there is not yet a confirmed valid key entry. The
operator also pasted the shell prompt text once, producing harmless
`command not found` messages.

No reboot is needed to activate an SSH key. Do not reboot until a new SSH
connection using this key has been verified; the pending `libc6`/kernel reboot
is a later operations step and must not risk access to the other projects on
the VPS.

### Resume procedure

On the VPS, paste only the following short commands, one at a time (never the
`ubuntu@...$` prompt):

```bash
t='ssh-ed25519'
p1='AAAAC3NzaC1lZDI1NTE5'
p2='AAAAINoWB4frsmJbgaQdM'
p3='nQsgPtraQ0+PYP0SEbmes'
p4='65T42D'
c='codex-oddsdesk-lightsail'
printf '%s %s%s%s%s %s\n' "$t" "$p1" "$p2" "$p3" "$p4" "$c" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
grep -n '^ssh-ed25519.*codex-oddsdesk' ~/.ssh/authorized_keys
```

The verification output must contain one complete line beginning with
`ssh-ed25519`. Existing authorized keys must be preserved. After that, obtain
the VPS public IPv4/DNS name and test SSH from this workspace using the local
private key. Only then perform the system reboot and continue deployment.

## 11. VPS deployment state — 2026-08-09

SSH was verified successfully with the dedicated key:

- Host: `54.154.121.30`
- User: `ubuntu`
- Remote identity: `ip-172-26-14-25`
- OS: Ubuntu 24.04.4 LTS
- Kernel: `6.17.0-1019-aws`
- `/var/run/reboot-required` exists; **no reboot has been performed**
- 2 GiB RAM + 2 GiB swap; `chrony` active; no failed systemd units

The existing `/home/ubuntu/p` repository is `holybunnie/probe` and its
`delphi-agent.service`/`delphi-paper.service` units were inspected but not
modified. Oddsdesk is isolated separately:

- Staging clone: `/home/ubuntu/oddsdesk`
- Service clone: `/opt/oddsdesk`
- Dedicated service account: `oddsdesk` (non-login)
- Both clones are at commit `ab30fad79b25a9065d7ad1c0eba4e045f43cf8dc`
- VPS `npm ci`, typecheck, build, and registration validation passed

Installed on the VPS:

- Onchain OS CLI `4.4.9` (service-accessible copy at `/usr/local/bin/onchainos`)
- OKX Trade CLI `1.4.2` (`/usr/bin/okx`)
- `okx-a2a` `0.2.2` (`/usr/bin/okx-a2a`)

`onchainos preflight` passed. `okx-a2a doctor` currently reports provider
binding missing and the daemon not running; this needs the real provider/auth
setup, not a guessed configuration. The existing CEX profiles are configured
under `ubuntu` (`okx-sub` is the default), but their credentials have not been
copied into the `oddsdesk` account.

The first read-only OKX.AI identity lookup returned `session expired:
onchainos wallet login`. This confirms that the ASP identity flow requires an
authenticated Agentic Wallet session in this environment. **Do not start
wallet login, create/fund a wallet, sign, or move wallet assets without the
operator's explicit authorization.** No wallet action has been taken. The
service runtime profile, `OKX_ASP_AGENT_ID`, and venue stop-custody result are
also not present yet, so the live engine has correctly not been started.

### Next deployment actions

1. Keep the Agentic Wallet flow paused until the operator explicitly
   authorizes wallet login/use for ASP identity registration.
2. Decide/configure the service-account OKX authentication and A2A provider.
3. Run the Day-0 venue discovery and record
   `config/runtime-profile.tradekit.yaml` (including position mode, leverage,
   fees, and stop custody).
4. Bind the reviewed `OKX_ASP_AGENT_ID` and run the dry cycle.
5. Install the systemd units and enable only the unit permitted by the stop
   custody result; watchdog is required only for client-held stops.
6. Obtain explicit approval before the pending system reboot, then verify SSH,
   systemd, and the other project services after reboot.

## 12. Current VPS verification — 2026-08-11

This section supersedes stale runtime notes above where they describe the VPS
before the current verification. The read-only check was performed over SSH
against the documented Lightsail host.

- SSH succeeded as `ubuntu`; remote identity: `ip-172-26-14-25`.
- `/opt/oddsdesk` is at commit `ab30fad`; the checkout has local/untracked
  deployment changes and should not be treated as a clean release snapshot.
- Onchain OS `4.4.9` preflight passed with integrity `ok`.
- ASP `#10706` (`AlphaGate`) is active and listed as eligible for task
  recommendations. Its A2A service is `Perpetual Momentum Signals`, priced
  at `15 USDT / month` with a `3-day` trial.
- `okx-a2a.service` is active and enabled as a user service; its heartbeat was
  observed during verification.
- The system-level `oddsdesk-engine.service` is active and enabled. The
  system-level demo service is inactive and disabled.
- The VPS wallet is authenticated and has buyer User `#10743` alongside ASP
  `#10706`.
- Buyer-side AlphaGate subscription is now active in its trial period. The
  successful creation used `useTrial=true`, `autoRenew=0`, normal device
  routing, and offline replay support. Subscription job ID:
  `0xd516a15c5778418e649717c18211a94becea9db9a691da7f3e644d2a6a9457d8`.
- Creation transaction:
  `0x413c568307b96a7c9bf40d8b51d3ff41bb20e1334354bffb9806cd6468d70122`.
- AlphaGate has one other active provider-side subscription, but that record
  belongs to buyer `#1791` and reports `copyTrade=0`; it is not the VPS
  wallet's self-subscription and does not enable autonomous trading here.

### Buyer-side route now provisioned

The buyer-side AlphaGate trial is provisioned on the VPS and auto-renew is
off. The buyer-side route is ready to receive AlphaGate perpetual signals on
the configured devices. The subscription alone still does not authorize
execution: the first actionable perpetual signal must pass the Trade Kit route
and an explicit execution amount/cap policy.

## 13. Session 9 — 2026-08-11, competition day 1

**Read this section first. It supersedes everything above where they conflict.**

### One-line state

The engine is live and correct end to end, but **cannot deliver signals because
the `oddsdesk` service user's wallet session is expired**. That is the only
blocker. Everything else works.

### The single next action

Complete the wallet login for the **`oddsdesk`** user, signed in as the account
that owns ASP `#10706` (wallet `0x4c24…0f05`). A different account mints a
different wallet, which does not own AlphaGate and still cannot publish.

```bash
# 1. mint a link
sudo -u oddsdesk env HOME=/opt/oddsdesk \
  /usr/local/bin/onchainos wallet login --phase init

# 2. START THE POLL BEFORE HANDING OVER THE LINK, and let it retry.
#    A single poll gives up after ~2 minutes with "login timed out waiting for
#    the result", which is what defeated four attempts this session. Never wrap
#    it in a short `timeout`, and never let it die with the SSH connection.
sudo -u oddsdesk env HOME=/opt/oddsdesk setsid nohup bash -c \
  'for i in $(seq 10); do /usr/local/bin/onchainos wallet login --phase poll \
     --session-id <ID> > /tmp/login.log 2>&1; \
     grep -q "\"ok\":true" /tmp/login.log && break; done' \
  >/dev/null 2>&1 </dev/null &

# 3. human opens the loginUrl and signs in
# 4. success check — must return ok:true AND list agent 10706 AlphaGate
sudo -u oddsdesk env HOME=/opt/oddsdesk \
  /usr/local/bin/onchainos agent get --page 1 --page-size 50
```

Signing in on the browser alone does nothing: the `poll` phase is what persists
the session. `session.json` existing is NOT proof of success — a killed poll
leaves a stale one. The only proof is `agent get` returning `ok:true`.

After the session is valid, the engine picks it up on its next ~5 minute cycle
with no restart needed. Watch for `[signal] … SUBMITTED venue-order …`.

### What was wrong, and what was fixed

1. **The policy was short-only and the market was long.** Its hard gate (BTC
   dual-venue 4h short + breadth >= 3/6) was measured open on only **50.7%** of
   540-day decision points, with a **longest continuous closed stretch of 47.8
   days** against a 14-day competition. Now bidirectional: **93.7%** open, worst
   idle stretch **3.2 days**. Revert by setting
   `FROZEN_CONTINUATION_POLICY.direction` back to `'short'`.
   - Declared exception: the bidirectional arm REJECTED on the promotion gate
     (PF 1.08, 3/5 positive folds) — but so does the short-only incumbent under
     that same gate (PF 1.09, 2/5, fold-concentration FAIL, all profit from two
     of five windows). No arm passed, so the tie-break was structural. The
     incumbent had never been tested against its own bar. Reproduce with
     `npm run continuation-direction-audit -- var/backtest/majors-540d-exact.json`.
2. **Every signal was refused at publication, in both directions.** The frozen
   policy set `scaleOutPrice = targetPrice` (it is a single-target 3R trade) and
   `validateSignal` demanded TP1 strictly between the entry band and TP2. The
   short branch had the identical requirement, so **direction was never the
   blocker** — the policy could never have traded. TP1 is now optional through
   plan, formatter, gate, parser and entry candidate; a single-target strategy
   publishes no TP1 at all rather than a TP1 equal to TP2.
3. **The payoff ratio was refused by rounding.** Prices publish at five
   significant figures and risk/reward are *differences* of quantised prices, so
   a policy targeting exactly the 3.0 minimum failed on quantisation alone. The
   comparison now admits exactly the slack rounding can explain, derived from
   the magnitudes in hand.
4. **Rank steering was dead code.** `parseLeaderboard` threw `ParserNotBuilt`
   and `run-engine` passed a hardcoded `null` cushion, so Stage 3 was
   unreachable and the binding axis unmeasured — in a module the build spec
   calls the highest-leverage in the build.
5. **Two observability holes**: the cycle log discarded the policy's own
   stand-down reason, and in live mode a refused signal logged only a count with
   no reason. Both now print. The second is what finally exposed the expired
   session.

### Leaderboard — now real

`npm run capture-leaderboard` drives a real page and reads its own signed
response. There is a JSON API at
`/priapi/v1/wallet/activity/hackathon/rank` (also `/chart`, `/profile`,
`/status`, `/deadline`) on `www.okx.ai`, but OKX signs requests at runtime with
an EC client signature and fingerprint token, and **the signature covers the
URL** — so unauthenticated curl returns `50113`, and rewriting `limit` after the
app signs is rejected too. Hence the browser. Chromium is installed on the VPS
for the `oddsdesk` user.

The board exposes a **top-10 window on a 63-entrant field**. That prices the
podium but cannot give our own rank or the attrition rate until we are inside
the window, so `computeMetrics` correctly refuses and Stage 3 stays unreachable.
`podiumTargets` reads the thresholds without needing our row.

**The podium is cheap.** Day-1 readings: rank 1 was +72.65%, but **rank 3 was
+1.28% / 5.19 USDT**, later +1.39% / 13.39 USDT — roughly **+4.2% on our 320
Principal Base**, with the *dollar* axis binding at our size. Do not conclude
from the top number that this is unwinnable; that error was made and corrected
this session. Attrition is violent and real: `Helios Terminal` led at +98.09%
and left the top ten within the hour; `1M · 斯巴达` went +19.57% -> +5.42%.

### Two identities on the VPS — do not confuse them

| | ASP daemon | Trading engine |
|---|---|---|
| unit | `okx-a2a.service` (systemd **--user**) | `oddsdesk-engine.service` (system) |
| user | `ubuntu` | `oddsdesk` (uid 997, nologin) |
| HOME | `/home/ubuntu` | **`/opt/oddsdesk`**, not /home/oddsdesk |
| creds | `/home/ubuntu/.onchainos/` | `/opt/oddsdesk/.onchainos/` |

The ASP daemon's session is healthy and heartbeating. The engine's is not. They
are separate stores, which is why the ASP is unaffected by engine work.

**The ASP must never go offline** (rule 3.2; deleting its service is
disqualification under 3.3). It has been continuously active since
`2026-08-10 15:16:12 UTC` with `NRestarts=0` and linger enabled. Engine
restarts cannot touch it. Do not "fix" the engine login by copying credentials
from `ubuntu` — a shared session risks invalidating the daemon's, which is the
one thing that must not break.

Anything engine-side must be run as:
`sudo -u oddsdesk env HOME=/opt/oddsdesk <cmd>` — the repo is owned by
`oddsdesk` and omitting HOME makes `npm ci` fail obscurely. Use
`/usr/local/bin/onchainos`; `/home/ubuntu/.local/bin/onchainos` is not readable
by that user.

### Deploy procedure that worked

Stop engine -> `git fetch` + `reset --hard <sha>` as `oddsdesk` -> `npm ci` ->
typecheck -> vitest -> **dry preflight** -> start. `reset --hard` is safe: the
runtime profile and `var/` are gitignored and survive. Always run the dry
preflight (`run-engine.ts` with no flags) — it is what caught the publication
blocker before any money moved.

### Current live state

- VPS at `c269bba`, engine **active**, `NRestarts=0`, stop custody `venue-held`.
- Equity **319.90 USDT**, peak 319.90, **no positions, no orders, no trades**.
- Typecheck and **479 tests** pass locally and on the VPS.
- Each cycle: generates one candidate, refuses at delivery on the expired
  session. Example: `S-260811134719-BNB-L`.
- Observed size: 3.62x leverage on BNB — correct arithmetic for 3% risk against
  a tight 2xATR stop (0.83% of price), inside the 5x cap, but above the 0.5-2x
  the spec anticipated at 2% risk. Consequence of the 3% setting, not a bug.
- Competition rule 3.1: at least one valid trade or the entry is void. Still
  zero trades.

### Do not repeat these

- Do not conclude the competition is unwinnable from rank 1's number; the
  target is rank 3's.
- Do not treat the frozen policy as validated because it is labelled frozen.
  The promotion gate had only ever been applied to challengers.
- Do not hot-patch `validateSignal` to force a trade through; it is what makes
  Law 6 structural.
- Do not wrap the login poll in a short timeout, and do not trust
  `session.json` as evidence of a session.

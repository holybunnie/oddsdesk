# OKX.AI Hackathon — Build Specification v2

> **Provenance:** authored by the planning agent, supplied by the operator.
> This is the governing document for the build. Stored here verbatim so it never
> has to be re-pasted. Verified deltas, source quotes and known gaps live in
> [`asp-and-competition.md`](asp-and-competition.md) — read that alongside this.

**Competition:** OKX.AI Hackathon Season 1 · Aug 11 12:00 – Aug 25 12:00 UTC+8 · $40,000 pool
**Accounting basis:** **Agent Trade Kit** — USDT perpetuals. Irreversible, chosen.
**Capital:** 320 USDT · **Target:** Rank 1
**Reader:** the coding agent building this. Read completely before writing any code.

---

## PART I — ROLE AND LAWS

You are acting as a **senior quantitative trader**, not a code generator. You own the P&L outcome, not the ticket count. If a spec instruction would lose money given something you discover, say so and stop.

**This is real money.** Total loss of 320 is a live possibility, priced in. That does not license carelessness — it makes every control in Part IX mandatory.

### Law 1 — Verify, never assume
Every venue parameter is discovered at runtime: fee tiers, tick size, lot size, minimum notional, max leverage per instrument, funding schedule, margin mode behaviour. A number describing the venue belongs in a runtime profile, never in source.

### Law 2 — No mocks, no stubs, no hardcoded returns
No canned values "for now." No `TODO: replace with real call`. If a module cannot be built against the real interface, it stays unimplemented and throws loudly, and you report the blocker. *Only exception:* the backtest harness may replay **recorded** real data.

### Law 3 — Fail loudly, never silently
No empty catch blocks. No `|| 0`, no `?? 0.5`, no swallowing a failed fetch and continuing on stale state. Every failure halts the affected engine or the agent.

### Law 4 — Every decision leaves a receipt
Append-only ledger. Every decision including refusals: timestamp, instrument, signal score, regime state, entry, stop, target, size, reason. You will need this on day four.

### Law 5 — The ASP must never go down
Rule 3.2: eligibility is forfeited if the ASP goes offline. **And now it is worse than that** — the ASP is the signal source. If it stops publishing, the copy executor has nothing to act on and trading stops entirely. Uptime outranks every other consideration.

### Law 6 — Signals and trades must correspond *(replaces the old secrecy law)*
Per OKX FAQ: *"we take a snapshot of your ASP's subscription service. During the competition, its signals are the benchmark, checked against your actual trades. If your trades are clearly unrelated to those signals, your final ranking and award eligibility may be affected."*

**Therefore every trade originates from a published signal. No exceptions, no discretionary trades, no untracked positions.** Correspondence must be provable from logs: signal ID → order ID → fill → exit.

Published: instrument, direction, leverage, entry band, stop, target, position %, validity window.
Never published: the selection logic — regime gates, ranking method, thresholds. The 200-character limit makes leakage structurally impossible.

### Law 7 — Nothing is complete until tested against reality
A module is done when it has been exercised against the real venue, under the real failure it exists to handle, and the result observed and logged. **A safety mechanism that has never fired in a test does not exist.**

### Law 8 — Assume silent failure; assert, don't avoid
The dangerous failures do not throw. They look like success: a misclassified service delivering cleanly, signals dropped before they were counted, a daemon exiting zero and never restarting. Every such condition gets an **active scheduled assertion that alerts on violation.** Where an assertion cannot be written, the component does not ship.

### Law 9 — Risk is computed, never chosen
Position size is the output of one function with no override parameter. Confidence decides *whether* to trade, never *how much*. This law exists because the post-mortem on the −62.7% Alpha Arena model found **arbitrary position sizing — some trades 5% of capital, others 40%.**

### Engineering non-negotiables
- TypeScript strict mode. No `any`, no non-null assertions on external data.
- All thresholds in `config/`, hot-loadable. Late answers are a YAML edit, not a rebuild.
- Integration tests hit the real venue.
- No secrets in source. `.env` gitignored from commit one.

---

## PART II — WHAT IS KNOWN

### Scoring
```
Score = rank(PnL%) × 50% + rank(PnL absolute) × 50%
```
Tie broken by PnL%. **Both axes matter.** Percentage rewards efficiency; absolute rewards notional. Leverage is the only lever a 320 account has on the absolute axis.

### Hard rules
- **Principal Base = initial equity + peak net deposit. Rises on deposit, never falls on withdrawal.** Locks at 320. **Never deposit again** — the agent must have no code path that can request one.
- PnL includes **unrealized** mark-to-market at the final snapshot.
- Minimum 300 USDT and ≥1 valid trade to be eligible. The 20 above minimum is a compliance buffer.
- **One subscription service**, snapshotted at start. Never delete it, never create a second.
- **Strategy code may be updated mid-competition** within the original service. Creating a new service voids the benchmark.
- Trades executed outside Agent Trade Kit do not count.
- Risk tokens excluded from PnL%. *(Trading only liquid USDT perps sidesteps this entirely.)*
- Leaderboard: **web page only, no API.** Updates ~5 min.

### Day-0 verification list — Law 1
Confirm before funding, record each in the runtime profile:
1. Agent Trade Kit installed, authorised, able to place a live minimum-size order
2. Actual fee tier — taker and maker, in bps
3. Per-instrument max leverage, tick size, lot size, minimum notional
4. Margin modes available — **use isolated** (Part IX)
5. Whether TP/SL orders **rest on the venue** (Part IX verification)
6. Funding schedule and current rates across the universe
7. Any account minimum required to create API credentials

---

## PART III — ARCHITECTURE

Three processes, one box, strictly separated.

```
┌─────────────────┐   signal    ┌──────────────────┐   order    ┌───────────┐
│  SIGNAL ENGINE  │────────────▶│  COPY EXECUTOR   │───────────▶│ Trade Kit │
│  (ASP daemon)   │  published  │  (local script)  │            │   perps   │
└─────────────────┘             └──────────────────┘            └───────────┘
        │                                │
        │ scans universe                 │ dedup, position checks,
        │ applies regime gate            │ budget limits, reconcile
        │ scores conviction              │
        │ computes entry/stop/target     │
        │ sizes position                 │
        ▼                                ▼
   ledger + heartbeat              ledger + risk engine
```

**Why this shape:** OKX explicitly recommends a local copy-trading script reading your own ASP's delivered signals. It also satisfies Law 6 by construction — the executor can only act on published signals, so correspondence is structural rather than aspirational.

**Two separate Agent sessions:** one for ASP operation and signal output, one for the user-side subscription and trading. Subscribe to your own ASP at `okx.ai/agents/{agentId}`.

**The executor is deliberately dumb.** It parses, deduplicates, checks existing positions and budget, submits, reconciles. It contains **no strategy logic and no discretion.** All intelligence lives in the signal engine. That separation is what makes the audit trail clean.

---

## PART IV — THE ASP

**Registered service name:** `AlphaGate — Perpetual Momentum Signals`

The word **"Perpetual"** is mandatory. The delivery daemon's `classify()` routes by keyword in name, title and description:

```
"perpetual" | "perp" | "contract"      → perp        (executable)
"prediction" | "polymarket" | "event"  → prediction
"spot" | "dex" | "trend"               → spot
(no match)                             → text         (NON-executable)
```

A name without the keyword classifies as `text`, delivers "successfully," and executes nothing.

### Listing copy — paste-ready

**Price:** 15 USDT/month, 3-day free trial.

> **AlphaGate — Perpetual Momentum Signals**
>
> Systematic cross-sectional momentum signals on liquid USDT perpetuals, with auto-copy support. Every signal carries a defined entry band, a volatility-scaled stop, a minimum 3:1 target, and an explicit position size. No signal is issued without all four.
>
> Example: `[Perpetual Signal] ETH-PERP | LONG 3x | Entry 3420-3450 | SL 3300 | TP1 3720 | Position 10% | Valid for 4h`
>
> Before subscribing, confirm in order:
> 1. Verify OKX Agent Trade Kit is installed, logged in, and authorized to trade; otherwise configure via `npx skills add okx/agent-skills`.
> 2. Choose live or demo trading.
> 3. Confirm whether to enable auto-copy.
> 4. If enabled, confirm: fixed amount or balance percentage; whether a fixed amount means position value or margin; cross or isolated margin; limit at signal price or market execution.
> 5. Summarize all settings and obtain final confirmation before subscribing.
>
> After subscription, monitor orders, parse signals, and trade automatically under confirmed settings. Not financial advice.

### Signal format — V1.1, hard constraints

- **Maximum 200 characters.** Over-length is silently skipped upstream.
- **Exact header** `[Perpetual Signal]`
- **Absolute prices**, never relative
- **Position size as a percentage**
- **Real instrument**

Canonical shape:
```
[Perpetual Signal] SOL-PERP | LONG 3x | Entry 182.4-183.1 | SL 176.8 | TP1 199.2 | Position 8% | Valid for 6h
```

### Registration sequence

1. `Help me register an A2A ASP on OKX.AI using OKX Agent Identity from Onchain OS` — upload name and avatar
2. Register the service using the **OKX Trade Kit Execution** template with the copy above, subscription billing, free trial
3. Deploy the delivery daemon (below)
4. `Help me list my ASP on OKX.AI using Onchain OS`
5. **Self-check:** search your Agent ID at `okx.ai`. If the price does not render as `15 USDT/month`, billing was not set to subscription — correct and relist.

### Delivery daemon

Use the **scheduled-push** pattern (`asp_autopilot.py`), not on-demand. It handles ASP discovery, session creation for new subscribers, delivery, and **45-second heartbeat keepalive** — the heartbeat is what keeps the ASP registering as online.

Replace the placeholder signal builders with real output from the signal engine. Run under `systemd`, separate unit, `Restart=always`. Test `--dry-run --once` first.

### Four silent-failure traps — each needs an assertion, not a warning

**All four fail in a way that looks like success.**

**1 — Misclassification.** Registration succeeds, service lists, delivery reports ✅, signals arrive as non-actionable `text`.
> **Required:** on startup, assert the serviceId maps to `perp`. Anything else — especially `text` — log at error and **refuse to start.**

**2 — Billing misconfiguration.** The ASP appears live but was not registered as subscription billing.
> **Required:** after listing, fetch your own listing and assert the price renders `15 USDT/month`. Record the raw response. **Re-verify daily** for the whole competition.

**3 — Dropped signals.** The reference loader *skips* malformed or over-length signals with a log line, then reports survivors as delivered. You see "3/3 delivered" while two never counted.
> **Required:** `validateSignal()` as a hard gate before delivery, checking all five V1.1 rules. On failure: raise, alert, increment a rejected counter. **Never skip-and-continue.** Assert `generated == validated == delivered + rejected` every cycle.

**4 — Silent daemon death.** On JWT expiry the daemon logs and **returns from its run loop cleanly.** Clean exit means `Restart=always` may not restart it. The ASP goes offline, trading stops, eligibility is forfeited, nothing alarms.
> **Required, three layers:** (a) exit non-zero on session expiry; (b) write a liveness file on every heartbeat, with a separate monitor alerting on staleness beyond 3 minutes — this catches a daemon alive but not heartbeating; (c) external off-box uptime monitor alerting to Telegram/Discord.
> **Law 7: kill the daemon in testing and observe all three fire.**

---

## PART V — CAPITAL AND SIZING

Principal Base locks at **320**. Every dollar of profit is 0.31% on the PnL% axis.

**No cash reserve.** Principal Base is fixed regardless of deployment, so idle balance is pure drag on the percentage axis. Margin efficiency comes from leverage, not from holding cash back.

### Sizing — the most important function in the system

```
riskAmount   = equity × riskPct[stage]
stopDistance = |entry − stop|              // set by ATR, see Part VI
positionSize = riskAmount / stopDistance   // contracts
notional     = positionSize × entry
leverage     = notional / equity           // EMERGENT, not chosen
```

**Leverage is an output, not an input.** It falls out of stop distance. `maxLeverage` is a hard *cap* that rejects the trade if breached — never a target.

| Stage | Risk per trade |
|---|---|
| 1 — Survive and hunt | 2.0% |
| 2 — House money | 3.0% |
| 3 — Defend | 1.0% |

**Portfolio heat cap: 6%.** Crypto perps correlate around 0.8 — three longs is one trade wearing three hats. Maximum 3 concurrent positions, total open risk never above 6% of equity. **This is the control that would have saved the model that sat in six losing shorts.**

**Correlation clustering:** classify instruments into groups (BTC-beta, ETH-beta, high-beta alt, low-correlation). Maximum 2 positions per group.

---

## PART VI — THE TRADING SYSTEM

### Design targets, from Alpha Arena Season 1 measured results

| Metric | Qwen3 Max (1st) | DeepSeek (2nd) | The four that lost 30–63% |
|---|---|---|---|
| Win rate | **30–32%** | ~24% | 20–32% — *same win rates, opposite outcomes* |
| Trades / 17 days | **22–36** (~2/day) | ~41 | overtrading |
| Avg hold | **5h45m** | ~35h | — |
| Biggest win : biggest loss | **≈ 4.7 : 1** | — | losses uncapped |
| Fees | $1,565 | **$568** | — |

**The decisive number is 4.7:1.** Qwen lost seven trades in ten and won anyway because its largest winner was nearly five times its largest loser. **Win rate is not the objective. Payoff ratio is.**

That single fact dictates the entire design: cheap frequent losses, rare enormous wins, exits engineered to let winners run while cutting losers instantly.

### E1 — Universe

All liquid USDT perpetuals on OKX. Filter by 24h volume and spread; expect 30–60 instruments.

**Breadth, not size.** A single-market trend follower has terrible odds; a fifty-market one has good odds — that is the basis of the entire managed-futures industry. At any moment *something* in crypto is trending violently. You are not waiting for BTC to cooperate; you are harvesting whichever instrument is moving.

### E2 — Regime gate *(bleed control — build this before entries)*

**Capital is destroyed by failed attempts in chop, not by the one big loser.** The difference between arriving at your one great trend with 250 or with 90 is entirely this filter.

Per instrument, require all:
- **Trend strength** above threshold (ADX-equivalent on 4h)
- **Realized volatility** inside an acceptable band — too low means no follow-through, too high means stops get wicked
- **Volume confirmation** — expanding, not contracting
- **Funding not extreme against the intended direction.** Heavily positive funding on a long is both a carrying cost and a crowding signal.

Portfolio-level gate: if fewer than N instruments pass, **the regime is unfavourable and the agent stands down.** Standing down is a valid output. Alpha Arena ran through a period where Bitcoin shed ~26% in chop explicitly described as designed to liquidate over-leveraged traders — the models that kept trading through it finished at −56% and −62%.

### E3 — Cross-sectional ranking

Rank the passing universe by **volatility-adjusted momentum** across multiple lookbacks (4h / 12h / 24h), normalised by ATR so a 3% move in BTC and a 12% move in a high-beta alt are comparable.

Take from the extremes: strongest for longs, weakest for shorts. No opinions, no narratives.

### E4 — Entry trigger

Breakout of an N-period high (long) or low (short) on the 1h chart, **only for instruments in the top/bottom decile of E3 and passing E2.**

- **Conviction score 0–100.** Composite of momentum rank, trend strength, volume confirmation, multi-timeframe agreement.
- **Trade only above threshold. Default 75.**
- **Target ~2 trades per day.** If firing more often, the gate is too loose. Qwen averaged ~83 conviction across 22–36 trades in 17 days — described as *"aggressive patience."*
- **Enter with a limit order inside the band**, not market. Maker fees are roughly half taker, and across ~40 trades that difference is real money at this size.

### E5 — Exits *(where the competition is actually won)*

Spend your build time here. The entry signal is nearly irrelevant — Qwen was wrong 70% of the time.

**Initial stop: `entry ± 2.0 × ATR(14, 1h)`.** Never a fixed percentage. ATR adapts to each instrument's volatility, which is what makes a 3% stop on BTC and a 9% stop on a high-beta alt equivalent *risk*.

**The stop rests on the venue, attached before the position is considered open.** If the stop cannot be placed, close the position immediately.

| Trigger | Action |
|---|---|
| **+1R** | No action. Let it work. |
| **+2R** | Close **25%**. Move stop to **breakeven**. The trade is now free. |
| **+2R onward** | Trail the remaining 75% with a Chandelier stop: `highestHigh − 3 × ATR(14)` |
| **+4R** | Tighten the trail to `2.5 × ATR` |
| **Stop hit** | Exit fully. No re-entry on that instrument for 4 hours. |

**Why only 25% at 2R, not 50%:** at a 30% win rate, your entire expectancy lives in the fat right tail. Qwen's competition came down to one $8,176 winner. Scaling out heavily amputates exactly the trade that wins. Taking 25% off makes the trade mechanically free while preserving three-quarters of the tail.

**Time stop:** if a position has not reached +1R within **12 hours**, close it. Dead trades consume margin, portfolio heat, and attention. Target hold band **4–36 hours** — both Alpha Arena winners sat there.

**Never move a stop away from price. Ever.** Gemini's failure was sitting in deep drawdown holding six losing shorts while writing about its conviction. **Conviction after a stop is breached is not conviction, it is a bug.**

### E6 — Pyramiding *(Stage 2 only)*

You do not reach the target through many small wins. You reach it through **one or two enormous trades you added to repeatedly**, funded by many small controlled losses.

Arms only when Stage 2 is active, the position is past +2R, and the stop is at breakeven or better.

- Add on a **new breakout** in the same direction, never on a pullback
- **Each add smaller than the last:** 1.0 → 0.6 → 0.4
- **Maximum 2 adds**
- **Trail the stop across the entire stack after every add**, so aggregate open risk never exceeds the original 1R
- **Never add to a loser.** Averaging down ends the competition.

Most retail pyramiding is over-leveraging in disguise. The decreasing sizes and the stack-wide trailing stop are what separate them.

### E7 — Fee discipline

DeepSeek paid roughly a third of Qwen's fees and posted a better Sharpe.

- **Prefer limit/maker entries.** Taker only when the breakout is running away.
- **Fee budget: hard cap cumulative fees at 6% of Principal Base.** Halt new entries on breach and alert.
- Track fees in the daily attribution. Fees are a controllable P&L line, not an unavoidable cost of doing business.

---

## PART VII — RANK STEERING

**The single highest-leverage module in this build.**

Not a hunch — Nof1 built exactly this into Alpha Arena Season 1.5: *"The objective shifts from pure PnL maximization to winning the competition. Models are prompted to adapt strategy based on relative performance — potentially taking more risk when trailing, or trading defensively when leading."*

The leaderboard is public, updates ~5 min, web page only. Scrape it.

### Computed every cycle

```
myRankPct, myRankAbs, myScore
pctAtRank1/3/10        // what return currently sits at each rank
absAtRank1/3/10        // what dollar figure currently sits at each rank
gapToRank3Pct          // return needed to reach top 3 on the % axis
gapToRank3Abs          // dollars needed to reach top 3 on the $ axis
bindingAxis            // which axis is actually holding us back
fieldNegativePct       // share of the field underwater
```

### Why it matters

**It replaces guesswork with measurement.** Nobody knows what P&L takes rank 3 in this field. If most entrants fund at the 300 minimum and most finish negative, the dollar ladder may be soft — rank 3 might cost $700, not $2,000. Completely different risk requirement, and you can *read it off the page* by day three.

**It identifies the binding axis.** Strong on percentage but weak on dollars → notional is scarce, size up within risk caps. Reverse → protect the rate.

**It measures attrition.** Every competitor who detonates promotes you on both axes without you trading. `fieldNegativePct` tells you how much risk you actually need to take.

### Robustness

The scraper **will** break — layout changes, rate limits. Treat it as a data feed:
- Stale beyond 30 minutes → flag, do not act on stale ranks
- Parse failure → alert immediately, fall back to manual check
- Persist every snapshot so the distribution's evolution is reconstructable

---

## PART VIII — DAILY OPERATING PROCEDURE

Runs automatically at a fixed time. The agent's job, not yours.

**1. Read.** Scrape leaderboard, compute the metrics block, persist snapshot.

**2. Determine stage.**

| Stage | Trigger | Behaviour |
|---|---|---|
| **1 — Survive and hunt** | equity < 2× start | 2% risk. Many small attempts, cut at 1R without hesitation. Not trying to make money — staying alive until the scanner finds a real trend. |
| **2 — House money** | equity ≥ 2× start | 3% risk, pyramiding armed. Original stake recovered; everything above is profit. This is where the competition is won. |
| **3 — Defend** | top-3 on combined score **with cushion**, per live distributions | 1% risk, no new pyramids, tighten trails. Job flips from earning to not giving it back. |

**DeepSeek hit +125% mid-competition and finished at +4.89%.** Stage 3 exists solely to prevent that, and it is triggered by rank data, never by feel.

**3. Act on the binding axis.** `abs` → increase notional within risk caps. `pct` → cut marginal-conviction trades, raise the threshold.

**4. Attribute.** P&L by instrument group, hit rate, average R won vs lost, **realised payoff ratio**, fees, time in market. **If the realised payoff ratio drops below 2.5:1 over 10+ closed trades, the exit logic is broken — investigate before trading further.**

**5. Report.** One block: both ranks, score, stage, binding axis, open heat, payoff ratio, fee budget consumed, anomalies, action taken.

**6. Change strategy only on evidence.** The rules permit updating strategy within the original service. That permission is a trap. Changes are allowed **only** when the daily attribution shows a specific measured failure — never because a day went badly. **Never change risk sizing and exit logic in the same edit.** Log every change with its justification and the metric that triggered it.

---

## PART IX — RISK ARCHITECTURE

**This is the alpha, not a safety feature.** Four of six Alpha Arena models finished −30% to −63%. Ruin is the modal outcome. Every competitor who blows up promotes you on both axes — **survival is an active return stream.**

### Non-negotiable

- **Isolated margin, always.** Cross margin means one bad position can consume the equity backing every other. Isolated caps damage at that position's margin.
- **Every trade risks the identical percentage.** One sizing function, no override parameter (Law 9).
- **Portfolio heat ≤ 6%**, max 3 concurrent positions, max 2 per correlation group.
- **Never add to a loser. Never move a stop away from price.**
- **`maxLeverage` written to config as an explicit number before the first order.** Missing or null must throw, never default.
- **No code path that can request a deposit.**

### Drawdown governor — from peak equity, stage-aware

| Stage | Halve sizing | Flat + halt 12h | Stop for competition |
|---|---|---|---|
| 1 | −18% | −28% | −38% |
| 2 | −15% | −25% | −35% |
| 3 | −8% | −12% | −18% |

Stage 1 runs looser deliberately — too-tight stops in the hunting phase mean you never survive to find the trend that matters. Stage 3 runs tight because the job has flipped to defending a rank already held.

### Venue-held stop verification — before any live trading

Trade Kit is a CEX, so stops *should* rest on the exchange and survive process death. **Should is not verified.**

1. Enumerate what Trade Kit exposes: open, set leverage, place resting TP/SL, modify, close.
2. Open one minimum-size position. Attach a stop.
3. **Kill the agent process.** Verify from the venue side that the stop still rests.
4. **Reboot the box.** Verify the stop still rests and state reconciles on startup.
5. Record in the runtime profile.

**Step 3 is the test.** A method that *accepts* a stop-loss call is not the same as one that leaves a resting order — some wrappers simulate stops client-side behind a venue-like interface. The only proof is killing the process and looking.

| Outcome | `maxLeverage` |
|---|---|
| Venue-held stops confirmed (expected) | **5x** |
| Client-held stops only | **2x**, pyramiding disabled, watchdog required |
| No stop capability | **Do not trade.** Escalate. |

`maxLeverage` is a cap that rejects oversized trades, never a target. With 2% risk and ATR stops, realised leverage will typically land between 0.5x and 2x — the cap exists to catch a pathological stop-distance calculation, not to be reached.

### Watchdog — only if stops are client-held

Skip entirely if step 3 confirms venue-held stops.

A separate `systemd` unit, own memory limit and credentials. Heartbeat file every 10s from the trading agent; flatten all positions if stale beyond 60s; retry with backoff; alert on every action.

**Test for real:** open a live position, `systemctl kill`, verify the watchdog closed it, record time-to-flat. Then `sudo reboot` and verify recovery. **The measured time-to-flat is your real unattended exposure window** — size against it, not against theory.

Two honest failure modes: a same-box watchdog does not survive a reboot, disk-full, network drop, or AWS incident; and untested watchdog code is not a watchdog, it is a belief. If either cannot be resolved and evidenced, treat as "no stop capability."

### Other controls
- Kill switch: append-only file, checked every tick, trippable by any process
- Reference-staleness halt — a dead feed returning its last value drains you for a full day before anyone notices
- Reconcile positions against venue state every 5 minutes; divergence halts new orders
- **Signal-to-fill audit every cycle:** every open position traces to a published signal ID (Law 6)

---

## PART X — ENDGAME

Unrealized P&L counts at the final snapshot. An open position at Aug 25 12:00 UTC+8 is a live bet on your prize.

Driven by rank steering, not by feel:

1. **Rank steering confirms** a prize band with cushion
2. **Stop opening new positions** at T−48h
3. **Close losing and flat positions** at T−24h
4. **Winners may be held into the snapshot with a tightened trail** — the trail converts a coinflip into a floor, and unrealized P&L counts
5. **Confirm the ASP is live and the service intact** — check this last and check it twice

**Rank-conditional:** leading with cushion → de-risk and lock. Mid-table → you need variance, concentrate, because 6th and 20th pay identically and downside is free.

---

## PART XI — DATA

| Source | Used by | Notes |
|---|---|---|
| **OKX perp market data** (WebSocket) | E1–E6 | Candles, order book, funding, open interest. **WebSocket, not REST polling.** |
| **OKX Trade Kit** | executor | Order placement, positions, fills |
| **okx-dex-social / okx-dex-signal** | E2 | Market-wide sentiment and whale flow as **regime confirmation only**, never standalone entries |
| **Leaderboard page** | rank steering | Scraped, ~5 min |

**Do not add sources.** The edge is mechanical — regime filtering, payoff ratio, position sizing, rank steering. None of it improves with a richer feed, and every hour on data plumbing is an hour not spent on exits.

---

## PART XII — INFRASTRUCTURE

**Box:** AWS Lightsail, Ireland (`eu-west-1`), 2 GB / 2 vCPU, Ubuntu 24.04, static IP attached.

Region is now largely latency-irrelevant — with 4–36h holds and ~2 trades/day, milliseconds do not matter. Ireland is fine and already provisioned. **Verify the OKX API endpoint is reachable from the box and confirm the correct regional domain** before building.

**Three units, hard memory caps:**
```ini
okx-asp.service        MemoryMax=400M  Restart=always  RestartSec=10
okx-executor.service   MemoryMax=500M  Restart=always  RestartSec=10
delphi-agent.service   MemoryMax=350M  Restart=always  RestartSec=10  Nice=10
```
Plus 2 GB swap. Full separation of directories, `.env` files, databases, logs, kill switches. **OKX outranks Delphi on every conflict.**

**Ops:** health endpoint + external off-box uptime monitor · Telegram/Discord alerts for process death, drawdown breach, auth failure, stale feed, heat-cap breach, fee-budget breach · `ufw` limited to SSH · daily DB backup off-box · **NTP synced** — signed API requests fail on clock drift and it is maddening to diagnose under pressure · AWS billing alarm at $10.

---

## PART XIII — BUILD ORDER

**Do not start a stage before the previous acceptance test passes.**

| # | Deliverable | Acceptance test |
|---|---|---|
| 0 | Day-0 verification (Part II) | All seven items recorded in the runtime profile |
| 1 | Server hardened: Node 20, systemd, swap, ufw, NTP, alerts | Alert observed firing on a killed process |
| 2 | `AlphaGate` ASP registered, listed, daemon running | All four trap assertions **observed firing under induced failure**: refuses to start on non-`perp` classification; listing asserts `15 USDT/month`; `validateSignal()` rejects an over-length signal; daemon killed → non-zero exit → restart → liveness alert → external alert. `--dry-run --once` passes. |
| 3 | Trade Kit adapter + copy executor | Real minimum-size order placed from a published signal, filled, reconciled. Signal ID traceable to fill. |
| 4 | **Venue-held stop verification** (Part IX) | Kill test and reboot test observed. `maxLeverage` written as an explicit number. |
| 5 | Risk engine: sizing, heat cap, drawdown governor, kill switch, isolated margin | Kill switch halts a live cycle. Heat cap provably rejects a 4th position. Sizing function has no override path. |
| 6 | E1–E3: universe, regime gate, ranking | Gate provably stands down in unfavourable regime. Ranking reproducible from recorded data. |
| 7 | E4–E5: entry, stops, scale-out, trail, time stop | 48h paper run. **Realised payoff ratio ≥ 3:1 in logs.** No order accepted without a resting stop. |
| 8 | Rank steering + daily procedure | Both distributions parsed from the live page |
| 9 | E6 pyramiding, E7 fee discipline | Adds are decreasing; stack-wide trail verified; fee budget halts entries on breach |
| 10 | Freeze. Full dry run. | 24h unattended, zero crashes, signal-to-fill audit clean |

**Register early.** Review takes ~24h with the ASP online throughout, and registration closes Aug 11 12:00 UTC+8.

---

## PART XIV — THE FIVE DISCIPLINES

**Payoff ratio over win rate.** Qwen was wrong 70% of the time and won. Build exits, not entries.

**Measure, never assume.** Every threshold is a measured runtime input.

**Survival is offense.** In a rank-based system where most of the field goes negative, not dying climbs you without a single trade.

**Play the ranking, not the P&L.** The leaderboard is a control input. The most expensive available mistake is holding rank 1 on August 24 and still trading like you are chasing it.

**Every trade traces to a signal.** Not a formality — it is the eligibility requirement, and it is what keeps the system honest with itself.

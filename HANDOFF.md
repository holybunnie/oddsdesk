# AlphaGate — Handoff

**Last updated:** 2026-08-09 (session 3 — E4 tested and wired, publication gate built)
**Competition:** OKX.AI Hackathon Season 1
**Registration closes:** Aug 11 12:00 UTC+8 — **the only irreversible deadline**
**Trading window:** Aug 11 12:00 → Aug 25 12:00 UTC+8
**Accounting basis:** Agent Trade Kit, USDT perpetuals. Chosen, irreversible.

---

## 1. Where things stand in one paragraph

The venue-agnostic core is built and tested (**175 tests, typecheck clean**).
The whole signal path — E1 through E5 — is now complete and tested, and
`scan.ts` runs it end to end against the live OKX venue and prints real entry
candidates with bands, stops, targets and conviction breakdowns. The publication
gate (`validateSignal`) is built. Credentials are installed on the box and the
order path is verified to reach the venue's margin check. Nothing can place a
live order yet, by design: `maxLeverage` is unset until the stop kill test is
observed, and `computeSize()` refuses to produce a position while it is unset.
What remains is the execution half — the Trade Kit adapter and the copy
executor — plus hardening. The two things blocking progress are both external:
funding the sub-account, and registering the ASP.

**Time check:** registration closes Aug 11 12:00 UTC+8, so it is now **~2 days
out** and the practical deadline for starting is roughly **Aug 10 midday**
(the ASP needs ~24h of review with the service online throughout). Everything in
section 6 can be built in parallel; registration cannot be started late. This is
the one thing that cannot be recovered by working harder later.

---

## 2. Decisions already made (do not relitigate without reason)

| Decision | Value | Why |
|---|---|---|
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

All under `/workspaces/oddsdesk`, branch `core-risk-ledger`. 175 tests passing.

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

2. **Register the ASP** — `AlphaGate — Perpetual Momentum Signals`.
   The word **"Perpetual" is mandatory** in the registered name; without a
   matching keyword the delivery daemon classifies the service as `text`, which
   delivers successfully and executes nothing. Review takes ~24h with the ASP
   online throughout, and registration closes **Aug 11 12:00 UTC+8**.
   Listing copy is in the spec, Part IV.

3. **Optional but recommended — a demo API key.**
   OKX → Demo trading → API key (Read + Trade, Perpetual). Then on the box:
   `okx config init`, answer `1`, **`Y`** to demo, profile name `okx-demo`.
   Without it the stop kill test must run on live money.

### Blocked on funding (not on time)

4. **Part IX stop verification — the gate on everything.**
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

**Start here next session:**

8. **Trade Kit execution adapter** — implements `ExecutionAdapter` against the
   `okx` CLI. Interface already exists; this is the concrete class. Note the CLI
   needs `--profile okx-sub` and the IPv4 `NODE_OPTIONS` on every call.
9. **Copy executor** — the deliberately dumb process. Parses published signals,
   deduplicates, checks positions and budget, submits, reconciles. **No strategy
   logic and no discretion** — that separation is what makes Law 6 structural.
10. **Server hardening** — systemd units with `MemoryMax`, ufw, NTP, alerts,
    pending reboot (`libc6` + kernel update outstanding).
11. **Leaderboard parser** — Aug 11 only, against the real page.
12. **Wire the engine loop** — the piece that joins what now exists:
    scan → E4 → `computeSize()` → `buildSignal()` → publish → `GuardedExecutor`.
    Two things it must own that nothing else can: the **cooldown state** E4
    expects (`scan.ts` is stateless and passes none), and a `SignalCycle` per
    cycle with `assertBalanced()` at the end.

---

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
- **The reference delivery daemon exits zero on JWT expiry**, so
  `Restart=always` may not restart it. Exit non-zero, write a liveness file,
  and monitor off-box.

---

## 8. Sequence from here

```
fund sub-account (320)  ──┐
demo API key (optional) ──┼──▶ stop kill test ──▶ write maxLeverage ──▶ live minimum-size order
register ASP ─────────────┘                                                      │
   (~24h review, deadline Aug 11 12:00 UTC+8)                                     ▼
                                                              E4/E5 + executor + hardening
                                                                                  ▼
                                                              freeze → 24h dry run → Aug 11
```

**The ASP is the critical path**, not the code. Everything else can be built in
parallel; registration cannot be started late.

---

## 9. Standing constraints

- **No code path may request a deposit.** Principal Base must never rise.
- **Every trade must trace to a published signal** (Law 6) — signal ID → order
  ID → fill → exit, provable from logs. OKX checks trades against ASP signals.
- **The ASP must never go down.** It is both an eligibility requirement and,
  under v2, the signal source — if it stops publishing, trading stops.
- **Strategy freezes the day before go-live.** After that the only levers are
  risk fraction, engine on/off, and stage.

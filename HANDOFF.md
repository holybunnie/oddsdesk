# AlphaGate — Handoff

**Last updated:** 2026-08-09 (session 6 — driver, scan pipeline and journal; the agent runs)
**Competition:** OKX.AI Hackathon Season 1
**Registration closes:** Aug 11 12:00 UTC+8 — **the only irreversible deadline**
**Trading window:** Aug 11 12:00 → Aug 25 12:00 UTC+8
**Accounting basis:** Agent Trade Kit, USDT perpetuals. Chosen, irreversible.

---

## 0. The two halves — read this if nothing else

Naming, because it has caused confusion: the **repo** is `oddsdesk`; the
**product** is **AlphaGate**, which is the name of the *signal service* we
publish through. That name comes from build spec Part IV. Nothing is registered
anywhere yet, so it can still be changed at zero cost.

This competition has two halves and they are not independent.

**Half one — the trading brain.** Fund a sub-account with 320 USDT and trade
USDT perpetuals for two weeks. Best combined return wins. This is the scanner,
the entry and exit rules, the risk limits. **Built and tested.**

**Half two — the publishing service (the ASP).** OKX does not let you simply
trade. You must publish every trade as a *signal* through a service other people
could subscribe to, and OKX checks your real trades against those published
signals. If they do not correspond, the ranking does not count. **Not built, not
deployed, not registered.**

**They are wired together deliberately.** The executor's input is published
signal *text*, not an internal decision object, so no order can reach the venue
without having been published first. That makes Law 6 structural rather than a
promise — and it also means the finished trading brain is **complete and idle**
until the publishing service exists.

### Trading half — what works, and what has never run

Verified against live OKX on 2026-08-09: 423 instruments in → 79 passed the
liquidity filter → 11 reached the entry gate → **5 signals** (BOME, PEOPLE,
PARTI, NEIRO, ESP, all long). Real prices, real ATRs, real conviction scores.

Built and tested (292 tests): E1 universe filter · E2 regime gate (stands down
in chop) · E3 volatility-adjusted momentum ranking · E4 breakout entry with a
conviction gate at 75 · E5 exits (2×ATR stop, 25% off at +2R, breakeven, 3×ATR
Chandelier trail tightening to 2.5× past +4R, 12h time stop, 4h cooldown) ·
sizing with no override path · portfolio heat cap · drawdown governor ·
kill switch · hash-chained append-only ledger · Trade Kit adapter · copy
executor · engine loop · driver.

**It cannot place a single order, by design.** `execution.maxLeverage` is unset
and `computeSize()` throws rather than defaulting. It stays that way until the
Part IX stop kill test is observed. **Nothing here has touched real money** —
and per Law 7, a safety mechanism that has never fired in a test does not exist.

Still missing on the trading side: E6 pyramiding and E7 fee budget are in config
but read by no code; daily attribution (Part VIII) is unbuilt; the leaderboard
parser cannot be written until the page exists on Aug 11.

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

**Blocks registration:**

1. **The name is too long for both fields.** `AlphaGate — Perpetual Momentum
   Signals` is **38 chars**; agent name caps at EN 3–25, service name at 5–30.
   Split: agent `AlphaGate` (9) + service `Perpetual Momentum Signals` (26).
   Safe, because the classifier reads name + title + description concatenated,
   so the mandatory `Perpetual` keyword still lands.
2. **An avatar is mandatory and the spec never mentions one.** An uploaded image
   file ≤1 MB. Links rejected, no default for the ASP role. We have none.
3. **One ASP per wallet address.** If the wallet already holds one, `create` is
   refused and the flow forces an update instead.

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
8. **Subscribing to our own ASP has no build task**, though Part III and
   tutorial step 5 both require it for copy trading.
9. **Competition registration is a second gate** after ASP approval — bind the
   OKX UID, fund ≥300 USDT. Part XIII says only "register early".

**Smaller:** the spec's `classify()` table omits `option` and
`defi|liquidity|lp`; the free trial is fixed at exactly 72 h; the fee must be a
quoted digits-only string (`"15"`, never `15 USDT`); prizes run 4th–40th at $500
each; rule 3.2 requires the service to stay usable **by other subscribers**.

### Where our build diverged from the spec

10. **`formatSignal` does not match the spec's own canonical shape.** Our defect
    — the implementation predates reading Part IV.

    - Spec: `[Perpetual Signal] SOL-PERP | LONG 3x | Entry 182.4-183.1 | SL 176.8 | TP1 199.2 | Position 8% | Valid for 6h`
    - Ours: `[Perpetual Signal] LONG BTC-USDT-SWAP entry 64700-64800 stop 64000 target 67200 size 40% id S-...`

    Different delimiters and labels, no leverage, no validity window, an extra
    id, `-USDT-SWAP` instead of `-PERP`. **Fix `src/signal/publish.ts`.** Two
    open questions for the planning agent:

    - The spec's published-field list has **no signal id**, and Law 6 requires
      traceability *from logs*. The id could live in the ledger against the
      delivery `jobId`, freeing ~24 of the 200 characters — but `CopyExecutor`
      dedupes on the id in the text today, so dedupe would move to the `jobId`.
    - **Asset naming:** spec and both official examples say `-PERP`; Trade Kit
      places orders against the instId `-USDT-SWAP`. Ours can map; a third-party
      subscriber's agent would have to as well.

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

4. **Optional but recommended — a demo API key.**
   OKX → Demo trading → API key (Read + Trade, Perpetual). Then on the box:
   `okx config init`, answer `1`, **`Y`** to demo, profile name `okx-demo`.
   Without it the stop kill test must run on live money.

### Blocked on funding (not on time)

5. **Part IX stop verification — the gate on everything.**
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

Then 10 and 11.

10. **Server hardening** — systemd units with `MemoryMax`, ufw, NTP, alerts,
    pending reboot (`libc6` + kernel update outstanding).
11. **Leaderboard parser** — Aug 11 only, against the real page.
12. ~~**Wire the engine loop**~~ — done. What is still missing around it:

    All done except the publisher, which is item 13.


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

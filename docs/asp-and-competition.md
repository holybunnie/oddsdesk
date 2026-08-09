# ASP registration & competition rules — authoritative reference

**Source:** the OKX.AI Hackathon event page and
<https://web3.okx.com/onchainos/dev-docs/okxai/a2a-subscription>
(Dev portal → Quickstart → A2A Subscription Services), captured 2026-08-09.

This file exists so the registration path never has to be re-derived from memory
or re-explained. Where something below is quoted from the source it is marked
**[verbatim]**. Where it is our reading of the source it is marked **[our
reading]**. Anything not marked is a direct paraphrase of the source.

**If you are about to guess at a field, a format, or an ordering — stop and read
this file first. Everything here was checked against the source.**

---

## 1. The ordering (this was wrong in earlier sessions)

The ASP must be **built, deployed, and listed** before it can be registered, and
the competition entry comes *after* ASP approval. Registration is the output of
deployment, not a prerequisite for it.

```
build ASP service + deploy delivery daemon on a stable server
        ↓
list the service on the marketplace
        ↓
submit for review — ~24h, ASP must stay ONLINE THROUGHOUT   [verbatim: "Keep ASP online throughout the review."]
        ↓
ASP approved
        ↓
register for the competition (step 5) — bind wallet/UID, fund ≥300 USDT
        ↓
Aug 11 12:00 UTC+8 — registration closes, no entries after
```

**Deadline:** registration closes **Aug 11 12:00 UTC+8**. Competition runs
Aug 11 12:00 → Aug 25 12:00 UTC+8.

Because review takes ~24h and the ASP must be online for all of it, the last
safe moment to submit for review is roughly **Aug 10 midday UTC+8**.

---

## 2. Service type — A2A subscription, not A2MCP

Settled by competition rule 3.3 **[verbatim]**:

> Each ASP must offer one subscription service to enter. It's snapshotted at the
> start as the scoring basis for the whole competition; if there are multiple
> subscription services, the earliest-created one is used. If it's deleted
> mid-competition, the ASP loses eligibility.

So:

- **A2A** (agent-to-agent), **not** A2MCP. A2A carries no endpoint field, so no
  public HTTPS endpoint is required to register. **[our reading, from the
  registration flow's step 2b: "A2A — no endpoint"]**
- Billing must be **monthly subscription**. Per-call does not satisfy rule 3.3.
- Create **exactly one** subscription service. A second one is not a backup —
  the earliest-created wins, so a mistaken first service becomes the scoring
  basis permanently.
- **Never delete it mid-competition.** Deleting forfeits eligibility.

**Listing self-check [verbatim]:** "Go to www.okx.ai and search for your Agent
ID. Open the details page and review the service. If the price is displayed as
'xx USDT/month,' the subscription service was created successfully. Otherwise,
the billing model was not configured as subscription-based and must be corrected
before listing again."

---

## 3. Signal classification — how a service becomes `perp`

The delivery daemon classifies each service by keyword. From the reference
script's `classify()` **[verbatim]**:

```python
def classify(title: str) -> str:
    t = (title or "").lower()
    if "perpetual" in t or "perp" in t or "contract" in t: return "perp"
    if "prediction" in t or "polymarket" in t or "event" in t: return "prediction"
    if "option" in t: return "option"
    if "defi" in t or "liquidity" in t or "lp" in t: return "defi"
    if "spot" in t or "dex" in t or "trend" in t: return "spot"
    return "text"  # Fallback: non-executable plain-text notification
```

Critically, the text it classifies is the **concatenation of three fields**
**[verbatim from `build_service_map`]**:

```python
classification_text = " ".join(
    value for value in (
        s.get("serviceName"), s.get("serviceTitle"), s.get("serviceDescription"),
    ) if isinstance(value, str) and value
)
```

**[our reading]** This resolves an earlier worry. The ASP *name* field is capped
at EN 3–25 chars, which "AlphaGate — Perpetual Momentum Signals" (38) would
break — but the keyword does not have to live there. `serviceName` (5–30) and
`serviceDescription` are both classified, and "Perpetual" appears naturally in
both.

**The failure mode this prevents:** a service classified as `text` delivers
successfully and executes nothing. It looks healthy from every angle except the
leaderboard. Assert the mapping at daemon startup and refuse to start otherwise.

---

## 4. Signal text format — V1.1

### Published examples [verbatim]

From the Trade Kit service description:

```
[Perpetual Signal] BTC-PERP | LONG 3x | 65000–65200 | Valid 12h
```

From the reference script's `sig_perp()`:

```
[Perpetual Signal] ETH-PERP | LONG 3x | Entry 3420-3450 | SL 3300 | TP1 3720 | Position 10% | Valid for 4h
```

### Stated rules [verbatim]

> follow the three strict rules in Section 3.5: (a) use a real asset, (b)
> express position size as a percentage, and (c) strictly follow V1.1 text
> requirements (allowlisted keywords / absolute prices / no more than 200
> characters).

So, confirmed:

| Rule | Status in our code |
|---|---|
| ≤ 200 characters | ✅ `publishing.maxSignalChars: 200` |
| Absolute prices, no relative language | ✅ `validateSignal` rejects relative phrases |
| Position size as a percentage | ✅ `sizePercent` |
| Real asset | ✅ instrument checked against the live venue list |
| Header `[Perpetual Signal]` | ✅ `publishing.perpHeader` |
| Allowlisted keywords | ⚠️ **the allowlist itself is not published** |

### ⚠️ OPEN RISK — our field format diverges from every published example

Our `formatSignal` emits:

```
[Perpetual Signal] LONG BTC-USDT-SWAP entry 64700-64800 stop 64000 target 67200 size 40% id S-260812090000-BTC-L
```

Every published example is **pipe-delimited with different labels**:

```
[Perpetual Signal] <ASSET> | <SIDE> <LEV>x | Entry <lo>-<hi> | SL <x> | TP1 <x> | Position <n>% | Valid for <n>h
```

Differences that matter:

1. **Delimiters** — ours is space-separated prose, theirs is ` | `.
2. **Labels** — ours says `stop` / `target` / `size`; theirs says `SL` / `TP1` /
   `Position`. If "allowlisted keywords" means these labels, ours fail.
3. **Asset naming** — theirs is `BTC-PERP` / `ETH-PERP`; ours is the OKX instId
   `BTC-USDT-SWAP`. **Unresolved:** the instId is what an order is actually
   placed against under Trade Kit, but the published examples do not use it.
4. **Leverage** — theirs carries `LONG 3x`; ours omits leverage entirely,
   because in our design leverage is an emergent output, never a chosen input.
   **[our reading]** Emitting the *realised* leverage would be honest and
   compatible; emitting a chosen one would not.
5. **Validity** — theirs carries `Valid 12h`; we compute `validUntilMs` but do
   not publish it.
6. **Signal id** — ours carries one for Law 6 traceability; no published example
   has one. It costs ~24 of the 200 characters.

The subscriber's Agent parses this text to place a trade, so a format it cannot
read means signals that deliver and execute nothing — the same silent failure as
misclassification.

---

## 5. Service description requirements

The description must contain **a signal example** and **the pre-subscription
copy-trading confirmations**, because the buyer's Agent reads them to configure
itself. The official Trade Kit template **[verbatim]**:

> "Perpetual trading signals, sent continuously with auto-copy support. Example:
> [Perpetual Signal] BTC-PERP | LONG 3x | 65000–65200 | Valid 12h. Before
> subscribing, confirm in order: 1. Verify OKX Agent Trade Kit is installed,
> logged in, and authorized to trade; otherwise help configure it via npx skills
> add okx/agent-skills. 2. Let me choose live or demo trading. 3. Ask whether to
> enable auto-copy; obtain my confirmation. 4. If enabled, confirm: fixed amount
> or available-balance percentage; whether a fixed amount means position value
> or margin; cross or isolated margin; limit at the signal price or immediate
> market execution. 5. Summarize all settings and obtain my final confirmation
> before subscribing. After subscription, monitor the order, parse signals, and
> trade automatically under my confirmed settings."

Registration text opens with **[verbatim]**: `"I want to register a new ASP
service. Service name: Trade Kit Smart Money Signals..."`

Other registration-flow constraints (from the `okx-ai` skill's
`identity-register.md`):

- **Avatar is REQUIRED for an ASP** — an actual image file, ≤1 MB, sent inline.
  Image **links are rejected**. There is no default fallback for an ASP.
- Agent name: CN 2–12 / EN 3–25 chars. Brand name, no test markers, no
  celebrity names.
- Service name: 5–30 chars, a noun phrase, must differ from the agent name, no
  price in the name.
- Fee: a **plain number as a quoted string** (`"10"`), digits only, no currency
  word or symbol, ≤6 decimals.
- Monthly subscription → `fee:""`, `subscription:[{"interval":"month","fee":"<n>"}]`.
  Add `freeTrial:"72"` (fixed 3 days) only if offering a trial.
- **One ASP per wallet address.** If one exists, the flow forces an update.
- A confirmation card + explicit confirm token is mandatory before any on-chain
  write. On-chain actions cost nothing — OKX covers gas.

---

## 6. The delivery daemon

OKX supplies reference scripts; we do not have to invent the delivery protocol.

- **`asp_autopilot.py`** — scheduled push. Runs continuously, delivers a round
  every `--interval` seconds (default 180), heartbeat every 45s.
- **`asp_push.py`** — on-demand push. Reads `signals.txt`, delivers to all
  active subscribers, exits.
- They can be combined: scheduled as a fallback, on-demand when the strategy
  fires. **[our reading]** On-demand fits our engine — signals are event-driven,
  not periodic — with scheduled as the keepalive.

CLI surface the daemon uses:

| Purpose | Command |
|---|---|
| Login check | `onchainos wallet status` |
| Find my ASPs | `onchainos agent get-my-agents` (role `2` = ASP) |
| Service list | `onchainos agent service-list --agent-id <asp>` |
| Active subscriptions | `onchainos agent subscribe-active --agent-id <asp>` |
| Provider subscriptions | `onchainos agent my-subscriptions --role provider` |
| **Deliver a signal** | `onchainos agent deliver <jobId> --deliverable-text <text> --agent-id <asp>` |
| Heartbeat | `onchainos agent heartbeat --agent-id <asp>` |
| Create P2P session | `okx-a2a session create --job-id <j> --my-agent-id <asp> --to-agent-id <buyer> --json` |

Job status codes: `-1 INIT, 0 CREATED, 1 ACTIVE, 2 SUBMITTED, 3 REJECTED,
4 DISPUTED, 5 ADMIN_STOPPED, 6 COMPLETED, 7 CLOSED, 8 EXPIRED, 9 FAILED`.

**Notes on the reference implementation [our reading]:**

- A new subscriber needs an XMTP session created before delivery, or the
  on-chain deliver succeeds while the P2P push silently fails.
- On JWT expiry the script **pauses delivery and returns** — it does not exit
  non-zero. Under `Restart=always` that means it stops delivering and systemd
  never notices. Our wrapper must exit non-zero and write a liveness file
  monitored off-box.
- Rejections/disputes are logged for a human, never auto-refunded.
- `--dry-run` and `--once` exist; smoke-test with both before going live.

---

## 7. Competition rules that constrain the code

| Rule | Constraint |
|---|---|
| 3.1 | Start with ≥ **300 USDT** equivalent. Must complete **≥1 valid trade** or the entry is invalid. |
| 3.2 | ASP must stay **online and serviceable** for the whole competition. Cloud server recommended. |
| 4 | Agent Trade Kit → **USDT Perpetuals only**. Trades outside Trade Kit do not count. |
| 5 | Accounting basis chosen at registration, **cannot be changed**. Ours: Agent Trade Kit, bind OKX UID. |
| 6 | `Score = PnL% rank × 50% + PnL rank × 50%`. Ties broken by PnL%. **Principal Base = initial net equity at registration + peak net deposit.** It rises on deposit and never falls on withdrawal. |
| 7 | Leaderboard updates ~every 5 minutes. |
| 8 | 1st $10,000 · 2nd $7,000 · 3rd $4,500 · 4th–40th $500 each. |
| 9 | Risk tokens excluded from PnL%. Self-trading / manipulation / abnormal flows may be disqualified. |

**The deposit trap, restated:** Principal Base includes *peak net deposit*, so
topping up mid-competition permanently raises the denominator and damages half
the score. No code path may request a deposit. Fund once, before registering.

---

## 8. Still unknown — do not guess these

1. **The V1.1 keyword allowlist.** The docs reference "allowlisted keywords"
   without publishing the list. Our labels (`stop`/`target`/`size`) may not be
   on it. → §4.
2. **Whether the asset field should be `BTC-PERP` or `BTC-USDT-SWAP`** for Trade
   Kit execution.
3. Whether signal validity (`Valid 12h`) is required or conventional.
4. The FAQ contents on the event page (collapsed in what we captured).
5. Whether the on-chain listing QA and the ~24h human review are the same gate
   or two separate ones.

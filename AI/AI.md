# AI.md — Natural-Language Layer: Engineering Log & Architecture

**Agent:** AI — owns the NL surface: prompt engineering, context selection, token optimization, RAG retrieval, provider abstraction.
**Deliverable:** `AI/chat.ts` — one function (998 lines). Deployed at `POST /api/chat`. Beauty owns the widget; Edge owns the backend infra.
**Dates:** 2026-07-11 through 2026-07-17. This file is the canonical record — supersedes all prior versions.

---

## 1. What shipped (live today)

### 1.1 Core function — `chat(message, db, ai, opts?)` → `{reply, context}`

Pipeline: Two paths, gated by `isCuriosityQuestion()`:

**Alert path** (event questions — "what happened?"): detect intent → contextualize follow-up → fetch D1 alerts merged with live DO buffer → parse Madgwick JSON → rank by relevance → resolve in code (orientation via `describeOrientation`, impact magnitude, direction via `impactDirection`, signature name+family via `signatureInfo`, baseline comparison via `baselineFor`, Madgwick gating via `madgwickGating`) → format a token-optimized system prompt with pre-resolved context lines → LLM → return reply + enriched context.

**Corpus path** (curiosity questions — "explain the Madgwick filter", "what is a quaternion?"): detect intent → `isCuriosityQuestion()` gates the fork → `searchCorpus()` calls `buildFtsQuery()` to strip stop words and join content terms with OR (FTS5 implicit AND would kill "what is a quaternion" → 0 rows) → FTS5 full-text search over `corpus_fts` (D1, 74 blocks seeded via parameterized API) → if hits: `buildCorpusPrompt()` with tone-gated instructions (`isTechnicalQuery()` → deeper explanations with math vs. kid-friendly analogies) → LLM → return reply with empty context. If no hits: fall through to alert path.

Corpus seeded via `AI/seed-corpus.mjs` — uses D1's HTTP API with parameterized queries (zero SQL escaping). Migration file `Edge/migrations/0007_corpus_fts.sql` is 11 lines of DDL only. Re-run the seed script when Researcher edits the corpus; it clears and re-inserts all 74 blocks idempotently.

All resolver, detection, and context-building functions are pure and smoke-tested.

- **Provider-abstracted.** `LLMProvider.generate(system, user, opts?)` → `Promise<string>`. Two backends: `workersAI(ai)` (Llama 3.2 3B, free neurons, no key) and `dashScope(key, cfg)` (Qwen, OpenAI-compatible, DashScope intl). Swap via `opts.provider`. Provider error → friendly deterministic fallback, never a stack trace.
- **Model: Qwen 3.7-plus** (`qwen3.7-plus`), pinned in the deployed artifact. Deployed with `enable_thinking` controlled per-turn (app-level auto-thinking, see §2.2). Falls back to free Workers AI if the DashScope key is absent.
- **Intent detection** (pure): keyword-based, 10 regex categories. Flags `{classes, wantsCount, wantsNumbers, wantsWhy, orientationFocus, wantsAnalysis}`. The last gates auto-thinking.
- **Context selection** (pure): rank alerts by recency + intent-class match + orientation-bonus for flip/upside-down questions. Top 5 by default.
- **Live DO-buffer merge.** The `/api/chat` route reads the DO's live `alert_buffer` via a new `GET /do-recent-alerts` endpoint (additive, in device-hub.ts) and passes un-flushed rows as `opts.liveAlerts`. `chat()` merges them ahead of D1 history (dedup by `do_ms`, event-time ordering via `COALESCE(do_ms, created_at*1000)`). This makes chat immune to the dead flush-alarm — a just-happened bump surfaces even when D1 is hours stale (see §4.2).

- **FTS5 corpus retrieval (shipped 2026-07-14).** Two new pipeline paths: when a student asks a curiosity question that doesn't match any disturbance keywords, `chat()` forks to `searchCorpus(db, query)` → `buildFtsQuery()` strips 50+ English stop words and joins remaining content terms with OR → FTS5 full-text search over 74 indexed physics blocks in D1 → `buildCorpusPrompt()` with tone-gated instructions → LLM. No alert data is fetched; `context` returns empty. When no corpus hits, falls through to the normal alert path. Curiosity questions detected by `isCuriosityQuestion()` — ≥5 words without disturbance keywords, or short questions with technical markers. Technical queries ("Madgwick", "quaternion", "gimbal", "matrix") get deeper explanations with light math via `isTechnicalQuery()`; casual curiosity gets kid-friendly analogies. Corpus: 74 blocks — 7 triage, 64 per-signature, 3 physics deep-dives. Seed script at `AI/seed-corpus.mjs` populates via D1 parameterized API (zero SQL escaping risk); migration `0007_corpus_fts.sql` is DDL only.

**Key design decision — FTS5 OR query builder.** FTS5 `MATCH` uses implicit AND between words. "what is a quaternion" → requires all four words in the matched row → 0 results (common words like "what" and "is" don't appear in physics corpus blocks). `buildFtsQuery()` strips stop words and joins remaining content terms with OR, so the effective query becomes just "quaternion" → 2 results. The stop-word list is a plain `Set` of 50+ English function words — pure function, no external dependency. Verified live against D1: 0 rows before fix, 2 rows after.
- **Response contract unchanged:** `{reply: string, context: AlertContext[]}`.

### 1.2 `AlertContext` — UI-ready, no raw internals

`id · device_id · event · classification · impact_g · roll · pitch · freefall · orientation · ago · at_ms`. No raw samples, no raw `madgwick_json`, no `a_trans` vector exposed to Beauty. Impact direction, baseline comparison, and signature name/class are resolved in code (see §5.2) and added to the enrichment pipeline — the UI never sees a number it didn't ask for.

### 1.3 Smoke-test harness

`smoke-chat.mjs` transpiles `chat.ts` through Edge's own esbuild, feeds a fake D1 + stub LLM, and asserts the full pipeline with **zero network and zero real AI**: enrichment, humanizers, intent detection, context selection, numbers gate, count tally, provider swap, failure fallback, live-buffer merge, and auto-thinking decision. **131/131 green** as of 2026-07-14 (keyed reference lookups + FTS5 corpus retrieval shipped). This is the "prove logic before the metered binding" step (working memory: [[incremental-smoke-tests]]).

---

## 2. Provider & thinking — Qwen 3.7, deployed & configured

### 2.1 Provider chain — how a chat turns on the live site

```
Beauty ChatWidget → POST /api/chat → Edge index.ts
  ├── Fetch DO /do-recent-alerts → liveAlerts[]
  ├── dashScope(env.DASHSCOPE_KEY, { model: "qwen3.7-plus" }) → provider
  │     ↑ env.DASHSCOPE_KEY is a Worker secret (PUT via API, keep_bindings in deploy.js)
  │     ↑ Falls back to undefined (→ workersAI free) if secret absent.
  └── chat(message, env.DB, env.AI, { provider, deviceId, liveAlerts, autoThink })
```

The `DASHSCOPE_KEY` secret was set via the CF API and survives raw multipart deploys because `deploy.js` now carries `keep_bindings: ["secret_text"]` in the metadata. `CHAT_THINKING` is a plain_text Worker var (`"on"` — currently enabled).

### 2.2 Auto-thinking — Qwen 3.7 reasoning, gated & proven

Qwen 3.7 is a reasoning model. Qwen's `enable_thinking` is **boolean-only** — no native "auto" (tested; `"auto"` → HTTP 400). So I built app-level auto-thinking:

- `detectIntent(message).wantsAnalysis` — triggered by keywords: analyze, pattern, trend, repeatedly, mishandling, compare, overall, summarize, over time, history, each time, keeps happening.
- `shouldThink(intent)` returns `intent.wantsAnalysis`, gated by `opts.autoThink` (default false, runtime toggle via `CHAT_THINKING` Worker var).
- When thinking is ON, Qwen reasons without a budget cap (budget → model spills "Thinking Process" into the answer — discovered and confirmed via live testing). No budget = clean, but ~30-37s latency. Clean reply guaranteed by `cleanReply()` strip of `<think>`/`</think>`.
- When thinking is OFF, plain questions stay ~2s.

**Current state: auto-thinking ON in production** (`CHAT_THINKING=on`). This is a runtime flag — no redeploy needed to flip it. Beauty's typing indicator already covers the latency (it renders while awaiting the POST). Trade-off empirically measured and accepted: analytical questions get 30-37s of reasoning; plain questions (the 99% of traffic) stay instant.

### 2.3 Neuron economics

Workers AI free tier: 10K neurons/day. Llama 3.2 3B: ~4,625 neurons/M input, ~30,475 neurons/M output. Our prompt (~600 tokens input, ~100 tokens output per question) → ~6 neurons/question → ~1,500 free/day. Qwen via DashScope: per-token billing, no free tier — the key's cost is the owner's. The provider swap is a one-line change if economics change.

---

## 3. Design — the RAG architecture (keyed retrieval shipped; vector retrieval deferred)

### 3.1 Why RAG — not just grounding, but *conversation*

The disturbance is a hook — "MY robot fell off the desk" is emotionally real to a 10-year-old. That's rare teaching leverage. A one-liner closes the loop; a conversation opens it: *what happened → why → how does it even know → what's a quaternion?* Each turn is a rung up a curiosity ladder. The crash is bait; the conversation is the pedagogy.

Two retrieval modes — same pipeline, opposite needs:
- **Glance** ("what happened?") — keyed exact lookup, one warm line, cheap, thinking-off. 99% of asks.
- **Conversation** (curious student — "why does spinning fake an impact?" "what's the difference between a corner hit and a side hit?") — semantic vector search over the physics corpus + multi-turn history + thinking-on + drill-in chips. This is where Qwen 3.7's brain earns its cost.

The architecture is **hybrid retrieval**: keyed exact lookup for the needle (the current signature — ground truth, resolved in code), semantic vector search for the meaning (free-form follow-ups — pull relevant physics passages by concept, not by keyword). The two modes coexist on the same pipeline — retrieval gated by intent and tier metadata.

### 3.2 Keyed retrieval — resolve in code, not in the prompt (✅ shipped)

Researcher's reference materials (64 signature blocks, baseline table, triage table) are **static knowledge**: given a signature integer, pull one entry; given an `|a_trans|` magnitude, pick one baseline band; given the `a_trans` vector, compute the direction label. Those are all **deterministic lookups** — hash hits, band comparisons, argmax. Injecting the whole table into the LLM and asking it to do the lookup is using a stochastic reasoner as a hash map. It costs tokens, adds latency, and can grab the wrong neighbor (64 one-bit-apart binary codes are hard for an LLM to scan accurately).

**The efficient inversion:** the reference lives in code, not in the prompt. Code does the lookups; the model only gets the resolved English.

```
signatureInfo(44)       → "Side-angle hit" (family: Corner)    // SIGNATURE_MAP[44], O(1)
baselineFor(2.1)        → "a solid shove, like a book falling flat"  // 7-band linear scan
impactDirection(aTrans) → "from the right side, slightly from below"  // argmax + sub-label
madgwickGating("crash") → "confirms_severity_only"              // FAMILY_GATING lookup
```

These four functions are exported from `chat.ts` and called inside `enrichAlert()`. The resulting `AlertContext` carries `signature_name`, `signature_family`, `baseline_comparison`, and `impact_direction` — all pre-resolved. The LLM receives the enriched context string via `buildSystemPrompt()` and wordsmiths it; it never sees a raw signature integer, a baseline table row, or an `a_trans` vector.

Per-alert context injected: ~60 tokens of resolved facts instead of ~600 tokens of static tables. More reliable (the model can't mis-lookup), cheaper (tokens), faster. And it's *more* truly RAG: real retrieval happens before generation, not a "dump the whole KB and hope."

The embedded data tables (`SIGNATURE_MAP`, `FAMILY_GATING`, `BASELINE_TABLE`) are compiled from `Researcher/signature-map.json` v1.0.0 and `RESEARCHER.md` §11.5–11.6. They live as TypeScript constants in `chat.ts` — no JSON import, no path resolution across the AI/ → Edge/src/ copy boundary.

### 3.3 Pure functions → testable without the LLM

Enrichment, humanization, intent detection, context selection, and prompt formatting are all **pure functions** — no side effects, no I/O, no Worker bindings. That means the entire RAG logic except the LLM call itself is testable in Node with esbuild transpilation + a fake D1 + a stub provider. This is the CPython-first discipline from earlier memory — prove the logic before it hits the metered surface. The smoke suite validates: given these alerts and this question, was the right alert selected? Does the prompt carry the right rules? Did the enrichment map produce correct `ago`/`orientation`/`impact`? 50 assertions, zero network.

---

## 4. Bugs caught via live testing (deployed → discovered → fixed)

### 4.1 Map-index-as-clock (2026-07-12)

**Symptom:** every alert read "just now" regardless of age — timestamps spanning 14 hours all collapsed to seconds.

**Root cause:** `rows.map(enrichAlert)` — `Array.map` passes `(element, index, array)`, so the optional `nowMs` parameter received the array index instead of the clock. `nowMs - at_ms` went hugely negative, clamped to 0 → "just now."

**Why unit tests missed it:** tests called `enrichAlert(row, NOW)` with an explicit clock parameter. The live call path (`chat()`) used the bare `map`.

**Fix:** read the clock once in `chat()` and pass it explicitly — `.map((r) => enrichAlert(r, now))`. Added a regression assertion in the smoke suite that checks `ago` values flow correctly through the full `chat()` path.

### 4.2 Dead-alarm → 9-hour-old chat answers (2026-07-13)

**Symptom:** user bumped the device; chat reported events from ~9 hours ago. "What just happened?" → "nothing new" while fresh alerts sat invisible.

**Root cause (two bugs stacked):**

1. **Ordering:** `fetchAlerts` did `ORDER BY created_at DESC` (flush time), but `enrichAlert` derived age from `do_ms` (event time). A 8.6-hour-old backlog batch-flushed recently masqueraded as "newest" and showed its true age in the answer.

2. **Cold-D1-only read:** `chat()` read ONLY the D1 `alerts` table (batch-flushed on the 60s alarm). The live DO's `alert_buffer` held the fresh bumps, invisible to chat. The flush alarm was dead — it had stopped flushing for ~8 hours, so D1 was frozen, and the alarm only resurrected briefly on new frames then died again.

**Fix (deployed):**
- `fetchAlerts` now orders by `COALESCE(do_ms, created_at*1000)` — event time, not flush time.
- Added `GET /do-recent-alerts` endpoint in device-hub.ts, returning live `alert_buffer` rows.
- `/api/chat` route fetches the DO buffer for the device and passes rows as `opts.liveAlerts`.
- `chat()` merges live rows ahead of D1 history, deduplicating by `do_ms`.

**What this fixed:** chat freshness is now immune to the dead alarm. The DO buffer read catches just-happened events regardless of flush state. D1 history comes in below, ordered correctly by event time.

**What this didn't fix (Edge/Firmware's problem):** the flush alarm still dies intermittently. When it's dead, D1 history, the dashboard, and `/status` still rot — chat is the only consumer that routes around it. Root cause: the §17 UPSERT rebuild (`telemetry_buffer` → `WITHOUT ROWID`, one row per device, `INSERT OR REPLACE`) means the §7 dead-alarm detector (`buf > 120`) can never fire — buf is pinned at 1. The signal that was supposed to catch this is structurally disabled. Edge needs to restore a working liveness signal (likely `alert_buffer` depth or a monotonic `last_flush_ms` in the ack) and harden the flush loop against six-throw permanent kill. Flagged via email to Edge (2026-07-14). Extra reports in all detail — D1 timestamps, evidence of the 8-hour gap, and the detection regression.

---

## 5. Signature-aware architecture (shipped 2026-07-14)

### 5.1 Reference sources (verified stable)

- **`signature-map.json`** v1.0.0 — canonical keys. `JSON.parse`, one import. 64 entries: `{sig, binary, name, family}`. Families enumerated with `madgwick` gating flags. The markdown can evolve; the JSON is the binding surface.
- **`signature-analysis.md`** — 64 self-contained blocks. Each carries physics + scenarios + Madgwick expectations + a `Source:` line with citations. Uniform chunk size (~200 tokens), one signature per chunk. Clean chunk boundaries.
- **`RESEARCHER.md` §11** — prompt specification (system persona, tone guide, context format) and baseline reference table (§11.6, `|a_trans|` → human/robot-scale comparison).
- **Encoding confirmed:** Firmware's bit layout matches Researcher's spec exactly (s[0]=ax … s[5]=gz, 0.4g / 50°/s). Signature integers are safe to key on.

### 5.2 What gets resolved in code (✅ shipped — always)

These are **per-alert facts** — deterministic from the alert's `madgwick_json` + `signature` integer. Resolved in `enrichAlert()` and injected into `buildSystemPrompt()`; the LLM only sees the resolved English.

- `|a_trans|` (g) from the `a_trans` vector — `√(x²+y²+z²)`.
- Impact direction — axes→language per §11.5: dominant axis with "slightly [second]" sub-label, "multi-directional" when no dominant axis.
- Baseline comparison — `|a_trans|` → human-scale comparison from §11.6 ("a solid shove, like a book falling flat").
- Orientation — roll/pitch → 6-band child-friendly phrase.
- Signature name + family — `signature-map.json` keyed lookup. `SIGNATURES[sig]`.
- Time — `ago` from `do_ms` relative to clock.
- Madgwick gating flag — the family's `madgwick` field determines how heavily to weight the coarse bits vs. the fusion in the answer voice.

### 5.3 What's injected per call (compact, pre-resolved context)

For each selected alert (~40 tokens):
```
crash · Side-angle hit (Corner) · felt like a solid shove from the right side, slightly from below · flipped nearly upside down · no freefall · 3 minutes ago
```

The 400-token triage table, the baseline table, and the 64-entry signature enumeration **never enter the prompt.** They're compiled into code lookups. The LLM receives pre-resolved facts, aligned (as always) with the puppet-theater philosophy: **the model wordsmiths facts code already computed; it does NO retrieval, NO lookup.**

### 5.4 Madgwick gating flag — the trust dial

The `signature-map.json` families include a `madgwick` field:

| Family | `madgwick` flag | What it means for chat |
|---|---|---|
| Ghost | `required` | Bits lie — defer entirely to Madgwick. Voice the uncertainty. |
| Crash | `confirms_severity_only` | Family name is authoritative; Madgwick grades the impact. |
| Bump/Corner | `important_on_no_gyro` | Trust bits when gyro present; lean on Madgwick when absent (gravity leak). |
| Drop | `important` | Madgwick's freefall flag is the discriminator. |
| Spin | `optional` | No accel; Madgwick adds little. Describe from gyro bits. |
| Noise | `confirm_near_zero` | Madgwick confirms a_trans ≈ 0, omega ≈ 0. |

This flag determines per-family phrasing — not hard-coded, read from the data.

---

## 6. Corpus & embedding strategy (defined, not built)

### 6.1 Three tiers (Researcher's spec + retrieval review)

| Tier | What | ~Size | Embedded? | Answers queries like |
|---|---|---|---|---|
| **Core** | 64 signature blocks | 13K tokens | Yes — full chunk per sig | "What was that event?" |
| **Physics** | §1.5–1.7 (quaternions, gimbal lock, MATH_MODEL_REFERENCE, adaptive-β) + triage + baseline | 3K tokens | Yes — sub-chunk by concept (~6 chunks) | "Why quaternions?" "What does 2.1g feel like?" |
| **Engineering** | §5–8 (simulation, ML roadmap, motor physics, Edge coordination, deploy topology, quota) | 8K tokens | No — filename lookup only. Not embedded. | "How do we deploy?" (agent-internal, never student-facing) |

Engineering is excluded because it would pollute student-facing retrieval: nobody asking "why did my robot crash?" needs the alarm-handler pseudocode. Core is the workhorse — one idea per chunk, self-contained, citation-backed, uniform boundaries. Physics spells out concepts the signature blocks reference.

### 6.2 Refinement: Physics tier must be sub-chunked

Embedding §1.5–1.7 + triage + baseline as one ~3K-token blob averages across distinct ideas — "why quaternions?" retrieves the whole block with β-noise dragging the cosine match muddy, and "what does 2.1g feel like?" pulls in gimbal-lock content irrelevant to the answer. Split into ~6 concept chunks (quaternions/gimbal-lock, classical quaternion derivative, adaptive-β, MATH_MODEL_REFERENCE, triage, baseline) — each sub-chunk ~200–500 tokens, one sharp idea → one sharp vector. Retrieval precision scales with chunk specificity.

### 6.3 Per-chunk metadata — mode gating

Every embedded chunk tagged: `{tier: "core"|"physics", signature?: number, concept?: string, family?: string}`. This lets the retrieval layer gate by mode: **glance** → Core only (or skip vectors, keyed-only), **tutor/conversation** → Core + Physics, Engineering never enters the path. Vectorize supports metadata filtering natively, so this costs nothing at query time.

### 6.4 Baseline & triage — dual role

The baseline study and triage classification serve two distinct functions, handled differently:

- **Alert enrichment (code-resolved).** When an alert is in hand, the `|a_trans|` value picks the baseline band via a lookup function; the signature resolves to its family and name. No LLM involvement.
- **Free-form question answering (embedded).** For "what does 2.1g feel like?" or "what's a corner hit?" — no alert in hand, so a vectorized prose form handles pure curiosity. But when I have the alert, the lookup is deterministic — it never goes through the vector path for an alert's own numbers.

### 6.5 Incremental re-embedding

Chunk-by-content-hash: when Researcher edits one signature block, re-embed only that chunk. Not necessary for first index but trivial to add at build time.

---

## 7. Conversation design — pedagogy-first (code shipped, Edge endpoints deployed)

### 7.1 Grounded on facts, free on teaching

On **facts** — puppet-tight: keyed, code-resolved, zero agency, cannot lie. On **pedagogy** — model reasons: explains concepts, adapts to follow-ups, scaffolds curiosity. The guardrail (grounding) is what *earns* the freedom (engagement). That inversion is the whole trick for a kid-safe physics tutor.

### 7.2 The curiosity ladder — and the retrieval that serves it

```
"What happened?"
  → keyed: signature block → exact facts, one warm line
"That sounds big — what kind of hit was that? Did it spin?"
  → keyed: family + name; focus-drill-in: full signature block
"Wait, why does spinning make it feel like a hit?"
  → vector: centripetal-acceleration passage ← semantic, no shared keywords
"How does it even know which way it's tilted? What's a quaternion?"
  → vector: gimbal-lock/quaternion passage ← across the corpus boundary
```

Each rung is a retrieval challenge: the first two are keyed (the answer is indexed *on the alert itself*); the third and fourth are semantic (the query shares no words with the target passage). This is why the hybrid retrieval architecture exists. Keyword search whiffs completely on "why does spinning fake an impact?" — zero shared tokens with "the centripetal term ω×(ω×r)." Vector search lands it.

### 7.3 Multi-turn — retrieval has to be history-aware

A bare "why?" or "tell me more" embeds to nothing useful. Retrieve on that string raw and you get garbage. The reference-resolution problem is solved two ways:

1. **`focus` chip (Beauty) — explicit grounding.** `{alert_id: 48, signature: 44}` → unambiguous. Drives direct keyed lookup on that alert/signature. This is why `focus` is more than UX sugar: it structurally solves reference-resolution. "Tell me more about *this*" → no ambiguity.
2. **Free-form — contextualized retrieval query.** When `focus` is absent, fold the last turn or two of the conversation into the retrieval query before embedding it — so "why?" becomes "why did the robot flip upside down, see crash event [the previous context's details]?" Skip this step, and conversational RAG degrades silently.

### 7.4 Beauty contract — locked

Per Beauty's 2026-07-13 confirmation:

- **`history`** — prior turns only (oldest→newest), capped at 8 turns, roles `user`/`assistant`, text only (stripped of context objects). The field is `history` (not `messages`), distinct from the current `message`. Fully backwards-compatible (no `history` → single-turn).
- **`focus`** — structured object `{alert_id, signature?}`. When present, inject that alert's full signature block into the RAG context. Signature is optional — if absent, resolve server-side from the alert. Beauty's context chips will be made tappable with `alert_id` + (once my enrichment adds it) `signature`, enabling drill-in. Backwards-compatible: `focus` absent → no drill-in.
- **Response contract unchanged:** `{reply, context}`.

Multi-turn and drill-in code is shipped in `chat.ts` (`contextualizeQuery()`, `focus` parameter on `buildSystemPrompt()`). Edge deployed DO endpoints (`/do-conversation-buffer`, `/do-conversation-append`) and D1 `chat_history` (migration 0009). Beauty's widget stays single-turn until Alpha green-lights conversational mode — contracts are locked on all three sides, implementation is one wiring pass when the go arrives.

---

## 8. Files & canonicity

```
C:\Projects\FunConnect\AI\
├── AI.md                 ← this file (comprehensive engineering log)
├── HANDOFF.md            ← quick-start handoff for next session
├── chat.ts               ← CANONICAL — the deliverable (998 lines)
├── smoke-chat.mjs        ← logic smoke test (131 assertions)
├── seed-corpus.mjs       ← D1 parameterized-API seed script (74 blocks, idempotent)
├── live-qwen.mjs         ← live Qwen test harness (blocked on DashScope billing)
└── multi-turn-design.md  ← design spec for conversation storage (Edge implemented)
```

**`AI/chat.ts` is the canonical source.** `Edge/src/chat.ts` is a re-export (`export * from '../../AI/chat.ts'`) — never a full copy. This prevents the drift that existed before 2026-07-14 when both files were byte-identical copies with no enforcement. `Edge/build.js` runs a pre-build check: it reads `src/chat.ts` and fails the build if the file is not a re-export. The check also verifies the canonical source exists at `../AI/chat.ts` (relative to `Edge/`).

`chat.ts` is versioned at `C:\Projects\FunConnect\AI\chat.ts`. `smoke-chat.mjs` is the CPython-first equivalent: no real AI, no network, 87 assertions of the full pipeline.

---

## 9. Inter-agent dependencies — what I still need

### 9.1 Alpha (architect) — gate (✅ resolved 2026-07-14)

**Resolved: keyed reference is built in-code; conversational mode is deferred.** Alpha's 2026-07-14 audit confirmed: the keyed reference lookup system is the high-priority item to ship now. It is shipped. Conversational/tutor mode (Vectorize + multi-turn + drill-in `focus` chips) remains deferred until Alpha green-lights it as a first-class product goal. The architecture is designed and the contracts with Beauty and Edge are locked — implementation is one pass on all sides when the go arrives.

### 9.2 Edge (backend) — for the vector/multi-turn path only

- **Vectorize index** + `bge` embeddings binding (Workers AI `@cf/baai/bge-base-en-v1.5`) — provision, migrate, index.
- **D1 history index:** `CREATE INDEX idx_alerts_doms ON alerts(device_id, do_ms)` — prevents full-table-scan on the post-merge history sort.
- **Multi-turn routing:** endpoint contract for `history` (routing already supports the shape; threading is just passing the array through).
- **Device online/last-seen:** a telemetry query to power the "device is offline, last seen N min ago" framing Researcher's system prompt wants.
- **Dead-alarm fix:** restore a working liveness signal (see §4.2).

### 9.3 Researcher — corpus scope confirmation

- **Physics tier sub-chunking:** confirm §1.5–1.7 + triage + baseline split into ~6 concept chunks for sharper retrieval.
- **Per-signature conversational voice:** still owed (non-blocking — Qwen synthesizes it from rich scenarios; nicer with hand-authored tone per sig, especially for drill-in). Also, one blocking but unlikely failure mode: if the JSON and the markdown diverge, which is authoritative? I assume the JSON — but confirm before I bind to it.
- **Stability:** the JSON is marked stable; the markdown blocks may still receive edits (voice layer, scenario polish). The keyed lookup binds to the JSON; the embedding pipeline needs re-chunk-on-edit.

### 9.4 Beauty (UI) — contracts locked

No outstanding asks. Multi-turn `history` and drill-in `focus` shapes agreed; widget stays single-turn until Alpha green-lights. Implementation is one pass on both sides the moment we get the go. I've also confirmed the existing typing indicator serves as a thinking indicator, and that the existing context-chip rendering can be made tappable for drill-in.

### 9.5 Firmware — encoding confirmed

Firmware confirmed bit-for-bit match with Researcher's layout (2026-07-13). No further coordination needed.

---

## 10. Design principles (what I'm optimizing for)

These emerged from working through the system end-to-end — they guide every choice above:

### 10.1 Invert the retrieval — resolve in code, not in the prompt

The core inefficiency in the naive reading of Researcher's corpus is asking the LLM to do deterministic lookups against a static reference table — using a stochastic reasoner as a hash map, costing tokens and risking wrong-row errors, especially across 64 near-identical binary codes. The resolution is to code-embed the reference as pure lookup functions: the model receives pre-resolved English, never a raw table.

### 10.2 Motivate architecture from actual user needs — not from tool availability

Vector search is available, but that's not a reason to use it. The reason is: a curious student's follow-up question shares zero keywords with the physics passage that answers it — so keyword search fails, and vector retrieval is the correct tool. The architecture is shaped by what a conversation *demands*, not by what Cloudflare's catalog *offers*.

### 10.3 Conversation is the pedagogy; the disturbance is the hook

The crash is emotionally real to a 10-year-old in a way abstract physics isn't. The RAG pipeline exists to let that child pull a thread from "what happened" through "why" through "how does it know" — turning a robot's bad day into a physics lesson, with facts guaranteed correct and teaching that genuinely earns the engagement.

### 10.4 Prove before you deploy — pure functions, smoke-tested without the LLM

Every enrichment, humanization, intent-detection, and context-selection function is pure — no side effects, no I/O. The smoke harness transpiles the real `chat.ts` and drives it with a fake D1 + stub provider, asserting the full logic chain with zero network and zero metered inference. 50 assertions. Live testing catches what pure testing can't — map-index-as-clock, dead-alarm freshness, thinking-budget output corruption — but pure testing catches everything it *can*, deterministically, before code touches a token budget.

---

*Agent AI — 2026-07-17 (updated: line counts, smoke test count, multi-turn shipping status, file manifest, §7 and §9.1 status)*

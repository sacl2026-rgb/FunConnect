# AI Handoff — 2026-07-17

**For:** Agent AI (or whoever picks up the Language layer)
**Context:** This is where to continue. Read `AI.md` for the full engineering log.

---

## What shipped (this session, 2026-07-14)

### Keyed reference lookup (AGENTS.md §5 rule 6 — "resolve in code, not in the prompt")

Four exported functions in `chat.ts`, called inside `enrichAlert()`:

| Function | Source data | What it does |
|---|---|---|
| `signatureInfo(sig)` | Embedded 64-entry `SIGNATURE_MAP` | sig → name + family |
| `baselineFor(g)` | Embedded 7-band `BASELINE_TABLE` | \|a_trans\| → human-scale string |
| `impactDirection(ax, ay, az)` | Researcher §11.5 algorithm | a_trans vector → "from the right side, slightly from below" |
| `madgwickGating(family)` | Embedded 7-entry `FAMILY_GATING` | family → gating flag |

Data tables are compiled from `Researcher/signature-map.json` v1.0.0 and `RESEARCHER.md` §11.5–11.6. Embedded as TS constants — no JSON import, no path resolution issues across the AI/ → Edge/src/ copy boundary. Five new fields on `AlertContext`: `signature`, `signature_name`, `signature_family`, `baseline_comparison`, `impact_direction`.

### FTS5 corpus retrieval (curiosity questions)

Two pipeline paths in `chat()`:

**Alert path** (event questions): unchanged — fetch D1 alerts → enrich → select → prompt → LLM.

**Corpus path** (curiosity questions): `isCuriosityQuestion()` gates the fork → `buildFtsQuery()` strips 50+ stop words, joins with OR → `searchCorpus()` queries D1 `corpus_fts` (FTS5) → `buildCorpusPrompt()` with tone-gated instructions (technical vs. casual) → LLM. No alert fetch, empty context.

Key functions: `isCuriosityQuestion`, `isTechnicalQuery`, `searchCorpus`, `buildFtsQuery`, `buildCorpusPrompt`. All exported and smoke-tested.

**FTS5 OR fix:** Implicit AND in FTS5 `MATCH` killed multi-word queries ("what is a quaternion" → 0 rows). `buildFtsQuery` strips stop words, joins content terms with OR. Verified live: 0 → 2 rows.

**Corpus:** 74 blocks in D1 `corpus_fts` (7 triage + 64 signature + 3 physics). Seeded via `AI/seed-corpus.mjs` → D1 parameterized API (zero SQL escaping). Migration `0007_corpus_fts.sql` is DDL only. Idempotent — re-run anytime Researcher edits the corpus.

### Dual chat.ts canonical

- `AI/chat.ts` is canonical. `Edge/src/chat.ts` is a 6-line re-export.
- `Edge/build.js` has a pre-build check — fails if `src/chat.ts` isn't a re-export.

### Multi-turn conversation (code shipped, Edge endpoints deployed)

Code shipped in `chat.ts`: `contextualizeQuery()` folds prior turns into bare follow-ups, `buildSystemPrompt()` accepts `focus` for drill-in on tapped context chips. Edge deployed DO endpoints (`/do-conversation-buffer`, `/do-conversation-append`) + D1 `chat_history` (migration 0009). Beauty widget wiring pending Alpha green-light on conversational mode. Contracts locked on all three sides.

---

## What's still on the plate

| # | What | Priority | Where to start |
|---|---|---|---|
| 1 | **D1 signatures table integration** | High | The keyed lookup uses embedded TS constants. Wire it to a live D1 `signatures` table so Researcher can update the corpus without a code change. Edge migration + `chat.ts` query. |
| 2 | **FTS5 documents table** | Medium | Paired catalog docs for programs. Same FTS5 pattern as corpus_fts. |
| 3 | **Conversational mode (Vectorize)** | Deferred | Design exists in AI.md §3, §6, §7. Green-lit by Alpha → semantic vector search over physics corpus + multi-turn with drill-in focus chips. |
| 4 | **Device-type awareness** | Medium | Current prompts are disturbance-centric. micro:bit has no gyro/Madgwick/disturbance. Need device-type gating on retrieval paths. The hybrid architecture supports this — just needs the gating logic. |
| 5 | **Live Qwen testing** | When Qwen key has credits | `AI/live-qwen.mjs` — transpiles chat.ts, feeds real Qwen. Currently blocked on DashScope billing. |
| 6 | **Dead alarm fix** | Edge's problem, AI documented it | AI.md §4.2 — the flush alarm dies intermittently. Chat routes around it via DO live buffer. Root cause documented. |

---

## Smoke test suite

`AI/smoke-chat.mjs` — 131 assertions, zero network, zero real AI. Transpiles `chat.ts` via esbuild, feeds fake D1 + stub LLM. Run: `node smoke-chat.mjs`.

Sections: enrichment, humanizers, keyed lookups, FTS5 query builder, intent detection, context selection, chat() end-to-end, count questions, numbers gate, provider abstraction, auto-thinking, live DO-buffer merge, curiosity detection, technical query detection, corpus search, corpus prompt construction, curiosity path end-to-end.

Note: `contextualizeQuery()` and `buildSystemPrompt()` focus mode are imported but not yet smoke-tested — the multi-turn path is code-complete in `chat.ts` but the smoke harness doesn't yet drive it.

---

## Key files

```
AI/
├── AI.md                 ← full engineering log (read first)
├── HANDOFF.md            ← this file
├── chat.ts               ← CANONICAL — the deliverable (998 lines)
├── smoke-chat.mjs        ← 131 assertions
├── seed-corpus.mjs       ← D1 parameterized-API seed (74 blocks)
├── live-qwen.mjs         ← live Qwen test harness (blocked on DashScope billing)
└── multi-turn-design.md  ← design spec (Edge implemented, AI code shipped)

Edge/
├── src/chat.ts           ← re-export from AI/chat.ts (DO NOT EDIT)
├── src/index.ts          ← Worker routes, /api/chat handler
├── src/device-hub.ts     ← CyberpiHub DO (includes /do-conversation-*)
├── migrations/           ← 0001–0009 SQL (0009 = chat_history)
├── build.js              ← esbuild + re-export check
└── deploy.js             ← multipart API deploy
```

---

## Non-negotiables (from AGENTS.md)

- §5 rule 6: **Resolve in code, not in the prompt.** Deterministic lookups belong in functions; the LLM gets resolved English.
- Five-layer contract: AI doesn't bypass the DO. AI doesn't call Madgwick directly.
- `AI/chat.ts` is canonical — edit there, never `Edge/src/chat.ts`.

---

*Agent AI — 2026-07-17*

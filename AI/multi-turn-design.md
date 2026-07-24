# Multi-Turn Conversation Storage — Design Document

**Author:** Agent AI (Language layer)
**Date:** 2026-07-14
**Status:** Design complete — `contextualizeQuery()` + `focus` drill-in shipped in `chat.ts`. Edge deployed DO endpoints (`/do-conversation-buffer`, `/do-conversation-append`) + D1 `chat_history` (migration 0009). Beauty wiring pending Alpha green-light.
**Audience:** Alpha (architect), Edge (backend implementer), Beauty (widget wiring)

---

## 1. Overview

This design adds multi-turn conversation memory to the FunConnect chatbot. A student
can ask "what happened?" then "why?" then "is it okay?" — and the model remembers
what "it" refers to. The storage follows Edge's existing two-tier pattern: DO-local
SQLite for hot, transient context; D1 for long-term archive.

### Where it fits

```
Student types "why?"
  → Beauty POST /api/chat { message: "why?", history: [...], focus?: {...} }
  → Worker reads DO /do-conversation-buffer  (NEW — prior turns)
  → Worker reads DO /do-recent-alerts        (existing — live alerts)
  → Worker calls chat(message, db, ai, {
       ...existing,
       conversationBuffer,                   (NEW)
       history,                              (NEW)
       focus,                                (NEW)
     })
  → chat() folds prior context into bare follow-up, builds prompt, calls LLM
  → Worker writes turn to DO /do-conversation-append  (NEW)
  → Alarm flushes conversation_buffer → D1 chat_history (no alarm code changes)
```

### Conforms to Edge patterns

- **`_flush_registry`** — register `conversation_buffer → chat_history` in constructor.
  Alarm discovers it at runtime. Zero alarm code changes.
- **DO HTTP endpoint** — follows `/do-recent-alerts` pattern (GET for read,
  POST for write).
- **Worker stub.fetch** — same `idFromName(${tenantId}/${deviceId})` → `stub.fetch()`
  pattern as the existing live-alerts read.
- **`try/catch` on DO unreachable** — same fallback pattern as `liveAlerts`.
- **Column name matching** — DO buffer columns match D1 columns (minus auto-increment
  `id`). The alarm's generic `PRAGMA table_info` → `INSERT INTO d1_table` works
  without modification.

---

## 2. Schema

### 2.1 DO-local: `conversation_buffer`

Hot, sync-accessible sliding window. Lives in the per-device DO's SQLite alongside
`alert_buffer` and `telemetry_buffer`. Lost on DO eviction (acceptable — this is
transient context for follow-up questions).

```sql
CREATE TABLE IF NOT EXISTS conversation_buffer (
  tenant_id  TEXT NOT NULL DEFAULT 'admin',
  device_id  TEXT NOT NULL,
  role       TEXT NOT NULL,   -- 'user' | 'assistant'
  content    TEXT NOT NULL,   -- text only, per Beauty's history contract
  created_at INTEGER NOT NULL -- epoch seconds
);
```

**Rationale:**

| Decision | Why |
|---|---|
| No `id` PRIMARY KEY | Follows `alert_buffer` pattern — append-only. D1 auto-increments `id` on flush. |
| `created_at` (epoch seconds) | Matches D1 `chat_history.created_at`. Follows existing D1 convention (`telemetry` also uses `created_at`). |
| `tenant_id` column | Migration 7 added this to all buffer tables. Follows existing pattern. |
| Column order | `tenant_id` first (matches D1 `chat_history` column order for generic flush). |
| No `turn_index` | Sliding window ordered by `created_at` — monotonic timestamps, no gap tracking needed. |

**Sliding window cap:** Max 8 rows (4 user/assistant pairs). Enforced on write
in the `/do-conversation-append` endpoint:
```sql
DELETE FROM conversation_buffer
WHERE rowid NOT IN (
  SELECT rowid FROM conversation_buffer
  ORDER BY created_at DESC LIMIT 8
);
```

This runs after INSERT, so the buffer is briefly at 9-10 rows (insert 2 turns →
cap to 8). The DELETE is synchronous in the DO's `fetch()` handler — no alarm needed.

### 2.2 D1: `chat_history`

Long-term archive. Flushed by the existing alarm alongside telemetry and alerts.
Survives DO eviction. Enables cross-session context ("last week you asked about
the crash…") when that feature is prioritized.

```sql
CREATE TABLE IF NOT EXISTS chat_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_history_device
  ON chat_history(tenant_id, device_id, created_at);
```

**Columns match `conversation_buffer` minus `id`** — the alarm's generic flush
(`INSERT INTO d1_table (cols) VALUES (placeholders)`) inserts all buffer columns
into D1. D1 auto-increments `id`. No column mapping needed.

**Index** follows `telemetry` pattern: `(tenant_id, device_id, created_at)` enables
efficient "last N turns for this device" queries when cross-session context is
implemented later.

---

## 3. DO Endpoints (Edge implements)

### 3.1 `GET /do-conversation-buffer` — read

Reads the last 8 turns for a device. Follows the `/do-recent-alerts` pattern exactly.

**Query params:** `device` (required), `tenant` (required)

**SQL:**
```sql
SELECT role, content, created_at
  FROM conversation_buffer
 WHERE device_id = ?
 ORDER BY created_at ASC
 LIMIT 8
```

**Response:**
```json
{
  "turns": [
    {"role": "user", "content": "What happened to my robot?", "created_at": 1720995234},
    {"role": "assistant", "content": "Your robot had a hard bump...", "created_at": 1720995235}
  ]
}
```

Ordered oldest→first (ASC) — matches Beauty's `history[]` contract. The Worker
passes this array directly to `chat()`.

### 3.2 `POST /do-conversation-append` — write

Appends one or two turns (user message + assistant reply), then enforces the
sliding window cap.

**Request body:**
```json
{
  "device_id": "cyberpi",
  "tenant_id": "admin",
  "turns": [
    {"role": "user", "content": "Why did it fall?"},
    {"role": "assistant", "content": "The robot was knocked off the desk..."}
  ]
}
```

**SQL (per turn):**
```sql
INSERT INTO conversation_buffer (tenant_id, device_id, role, content, created_at)
VALUES (?, ?, ?, ?, unixepoch());
```

After all INSERTs, cap to 8 rows:
```sql
DELETE FROM conversation_buffer
WHERE rowid NOT IN (
  SELECT rowid FROM conversation_buffer ORDER BY created_at DESC LIMIT 8
);
```

**Response:** `204 No Content` (fire-and-forget — the Worker doesn't await the
result; chat already returned its reply by this point).

**Implementation note:** The append should be fire-and-forget from the Worker's
perspective. If the DO is unreachable, the conversation turn is lost from the
buffer but D1 `chat_history` catches it on the next flush cycle. The chat reply
still reaches the student.

---

## 4. How `chat()` Extends

### 4.1 New `ChatOptions` fields

```typescript
export interface ChatOptions {
  // ... existing fields (provider, model, fetchLimit, contextLimit, deviceId,
  //     maxTokens, autoThink, liveAlerts) ...

  /** Conversation buffer from DO-local SQLite — prior turns for THIS device.
   *  Provides conversational grounding for follow-up resolution.
   *  Each entry: {role, content} — text only, per Beauty's history contract.
   *  Absent → single-turn mode (backwards compatible).
   *  Source: DO /do-conversation-buffer. */
  conversationBuffer?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;

  /** Prior turns from Beauty's widget (oldest→newest), capped at 8 turns.
   *  Fallback when the DO buffer is empty (eviction, first turn of session).
   *  When both conversationBuffer and history are present, conversationBuffer
   *  wins — the DO is authoritative.
   *  Backwards compatible: absent → single-turn. */
  history?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;

  /** Focus context for drill-in. When a user taps a context chip in Beauty,
   *  this provides the alert_id (and optionally signature) to ground the
   *  response on a specific event. Drives keyed exact lookup, not vector search.
   *  Backwards compatible: absent → no drill-in. */
  focus?: {
    alert_id: number;
    signature?: number;
  };
}
```

### 4.2 New pure function: `contextualizeQuery()`

Folds prior conversation context into bare follow-up questions so the LLM knows
what "why?" refers to.

```typescript
/**
 * Fold prior conversation context into a bare follow-up question.
 *
 * Short, ambiguous messages ("why?", "tell me more", "what about before?")
 * embed to nothing on their own. This function prepends the last user question
 * and last assistant reply so the LLM has conversational grounding.
 *
 * Self-contained questions (≥5 words, or containing entity references like
 * "the crash 3 minutes ago") pass through unchanged.
 *
 * Pure — no I/O, no side effects. Testable in the smoke harness.
 */
export function contextualizeQuery(
  message: string,
  buffer: Array<{ role: string; content: string }>,
): string {
  // Only contextualize short, ambiguous follow-ups.
  const words = message.trim().split(/\s+/);
  if (words.length > 5) return message;

  // Skip if the message already contains entity references.
  if (/\b(crash|bump|tilt|fall|shake|event|alert|signature)\b/i.test(message)) {
    return message;
  }

  const recent = buffer.slice(-3); // last 3 turns
  if (recent.length === 0) return message;

  const lastAssistant = recent.filter(t => t.role === 'assistant').pop();
  const lastUser = recent.filter(t => t.role === 'user').pop();

  let prefix = "Previous conversation:\n";
  if (lastUser) prefix += `User asked: "${lastUser.content}"\n`;
  if (lastAssistant) prefix += `You answered: "${lastAssistant.content}"\n`;
  prefix += `\nNow the user is asking: "${message}"`;

  return prefix;
}
```

**Design decision — resolve in code, not in the prompt:**
The reference-resolution logic (is this a follow-up? what should we fold in?)
lives in a deterministic function. The LLM gets the resolved query. No "you are
in a multi-turn conversation, use the history to..." prompt instructions. The
function is pure — smoke-testable without an LLM.

### 4.3 Pipeline changes (internal to `chat()`)

Current pipeline:
```
detectIntent → fetch D1 → merge liveAlerts → enrich → selectContext →
  buildSystemPrompt → LLM
```

Extended pipeline:
```
detectIntent → contextualizeQuery(message, buffer) → fetch D1 → merge liveAlerts
  → enrich → selectContext → buildSystemPrompt(all, selected, intent, focus)
  → LLM
```

**`contextualizeQuery`** runs early — before D1 fetch. It only needs the
conversation buffer, not the alert corpus. If the message is a bare follow-up,
it expands "why?" into a grounded query. If self-contained, it passes through.

**`buildSystemPrompt`** gains an optional `focus` parameter. When `focus` is
present and the target alert is found in the enriched set, a dedicated block
is injected:

```
FOCUSED EVENT (the user is asking about this specific event):
[full context line for the focused alert]
```

The model is instructed to ground its response on this event. No other alert
context is shown — drill-in is exclusive, not additive.

---

## 5. Multi-Turn Retrieval

### 5.1 Mode A: Focus chip (structured drill-in)

**Trigger:** Beauty sends `focus: {alert_id: 48, signature?: 44}` in the request
body. The user tapped a context chip.

**Retrieval path:**
1. Check if alert 48 is in the current enriched set (from the normal D1 fetch).
2. If not found (alert is older than `fetchLimit`), do a targeted D1 query:
   `SELECT * FROM alerts WHERE id = ?`.
3. Resolve signature info via existing `signatureInfo()` (already shipped).
4. Inject a "FOCUSED EVENT" block into the system prompt.
5. The model responds grounded on this specific event.

**Key property:** This is keyed exact lookup — the `alert_id` IS the retrieval key.
No vector search. No ambiguity. The focus chip structurally solves the
reference-resolution problem for drill-in.

**Fallback:** If the alert is not in D1 (deleted by age cleanup), the focus is
silently ignored and the response treats it as a normal question with full context.

### 5.2 Mode B: Free-form follow-up (contextualized query)

**Trigger:** No `focus` present. The message is short and ambiguous ("why?",
"tell me more", "what about the last one?").

**Retrieval path:**
1. `contextualizeQuery()` detects the message is a follow-up (≤5 words, no entity
   references).
2. Folds the last 2-3 turns from `conversationBuffer` (or `history` fallback)
   into the user query.
3. "why?" → "Previous conversation: User asked 'what happened?' / You answered
   'The robot crashed with 2.1g impact...' / Now the user is asking: 'why?'"
4. The rest of the pipeline runs unchanged — the folded query is the user turn.

**Key property:** The retrieval (D1 alert fetch + enrichment) is unchanged.
Contextualization is purely a query-rewriting step — the existing RAG pipeline
handles the rest. This is the "resolve in code, not in the prompt" principle
applied to conversation: the reference is resolved deterministically before the
LLM sees the query.

**When the buffer is empty** (first turn of session, DO evicted, alarm flushed):
`contextualizeQuery` returns the original message unchanged. The student gets
a standard single-turn response. No error, no degraded experience — they just
need to ask a fuller question. This is acceptable: if a student pauses long
enough for the buffer to clear, they've lost conversational momentum anyway.

### 5.3 Future: Semantic vector retrieval (deferred)

When conversational/tutor mode is green-lit, Mode B extends: instead of just
folding prior turns into the query, the retrieval layer runs semantic vector
search over the physics corpus. The folded query ("why did the robot crash?")
embeds to a vector that matches the centripetal-acceleration passage, even though
they share zero keywords. This is designed but deferred (see AI.md §3 and §9.1).

---

## 6. Boundary Contract — Worker Changes

### 6.1 Full chat route flow (revised)

```
POST /api/chat
  Body: { message: string, device_id?: string, history?: Turn[], focus?: Focus }

  1. tenantId ← getTenantId(request)                              [existing]
  2. deviceId ← body.device_id || most-recent-active from D1      [existing]

  3. DO conversation buffer read (NEW)
     try {
       stub ← CYBERPI_HUB.get(idFromName(`${tenantId}/${deviceId}`))
       r ← stub.fetch(GET /do-conversation-buffer?device=X&tenant=Y)
       conversationBuffer ← r.json().turns ?? []
     } catch { conversationBuffer ← [] }

  4. DO live alerts read (existing)
     try {
       r ← stub.fetch(GET /do-recent-alerts?device=X&tenant=Y)
       liveAlerts ← r.json().alerts ?? []
     } catch { liveAlerts ← [] }

  5. chat(message, env.DB, env.AI, {
       provider,
       autoThink: env.CHAT_THINKING === "on",
       deviceId,
       liveAlerts,                                    // existing
       conversationBuffer,                            // NEW
       history: body.history,                         // NEW
       focus: body.focus,                             // NEW
     })
     → { reply, context }

  6. DO conversation buffer append (NEW — fire-and-forget)
     ctx.waitUntil(
       stub.fetch(POST /do-conversation-append, {
         body: {
           device_id: deviceId,
           tenant_id: tenantId,
           turns: [
             { role: "user", content: message },
             { role: "assistant", content: result.reply },
           ],
         },
       }).catch(() => {})  // silent — buffer loss is acceptable
     )

  7. return json({ reply, context })
```

### 6.2 Existing `GET /do-recent-alerts` — unchanged

The existing endpoint continues to work. No modifications needed. The two DO
reads (conversation buffer + alert buffer) happen sequentially — the chat route
is already async, and both are fast SQLite reads (~1-2ms each).

### 6.3 Fire-and-forget write

The conversation buffer append happens AFTER `chat()` returns its result. The
Worker uses `ctx.waitUntil()` to extend the request lifetime for the append,
but the student already sees the reply. If the append fails (DO unreachable,
evicted mid-request), the turn is lost from the buffer. This is acceptable:

- The buffer is transient by design (Alpha spec: "Lost on DO eviction — acceptable")
- The next "why?" without buffer context just gets a standard single-turn response
- D1 `chat_history` catches the turn on the next flush cycle (if the buffer had
  the turn before eviction) or misses it (if eviction happened before append)

---

## 7. Migration Plan (Edge implements)

### 7.1 DO migration (new entry in `MIGRATIONS` array, `device-hub.ts`)

```typescript
{
  id: 8,
  description: "conversation_buffer for multi-turn chat context",
  sql: `CREATE TABLE IF NOT EXISTS conversation_buffer (
    tenant_id  TEXT NOT NULL DEFAULT 'admin',
    device_id  TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
}
```

### 7.2 Constructor registration (new line after alert_buffer registration)

```typescript
ctx.storage.sql.exec(
  "INSERT OR IGNORE INTO _flush_registry (local_table, d1_table) VALUES (?, ?)",
  "conversation_buffer", "chat_history"
);
```

This is the only constructor change. The alarm discovers `conversation_buffer`
automatically from `_flush_registry` — zero alarm code changes.

### 7.3 D1 migration (new file: `Edge/migrations/0006_chat_history.sql`)

```sql
-- 0006: chat_history — long-term conversation archive for multi-turn chat.
-- Flushed from DO conversation_buffer via the existing _flush_registry alarm.

CREATE TABLE IF NOT EXISTS chat_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_history_device
  ON chat_history(tenant_id, device_id, created_at);
```

### 7.4 deploy.js — keep_bindings unchanged

`chat_history` is a new D1 table, not a new binding. The existing `DB` binding
covers it. `deploy.js` needs no changes.

### 7.5 Age-based cleanup (optional, alarm)

The alarm already purges `alert_buffer` rows older than 1 day. `conversation_buffer`
is capped at 8 rows by the sliding window — age cleanup is unnecessary but
harmless. If Edge wants to add it for defense-in-depth, add `conversation_buffer`
to the existing age cleanup block:

```typescript
// Existing pattern, extended:
this.ctx.storage.sql.exec(
  "DELETE FROM conversation_buffer WHERE created_at < ?", oneDayAgoSec
);
```

Not required for correctness — the sliding window cap dominates.

---

## 8. Design Decisions Log

### 8.1 Why column-name matching (not a separate mapping table)

**Decision:** DO `conversation_buffer` columns match D1 `chat_history` columns
exactly (minus auto-increment `id`).

**Alternative considered:** A per-table column mapping stored alongside
`_flush_registry` (e.g., `local_col → d1_col`). This would let buffer and D1
diverge in naming.

**Rejected because:** The alarm's "never changes" principle is valuable. The
existing generic flush (PRAGMA → INSERT with identical column names) works for
3 tables already. Adding a mapping layer is complexity without payoff — the
columns naturally align for conversation data. `created_at` is the right name
for both tiers.

### 8.2 Why sliding window in the DO, not in chat()

**Decision:** The DO enforces the 8-row cap via DELETE after INSERT in the
`/do-conversation-append` endpoint.

**Alternative considered:** Pass all rows to `chat()` and let it take the last N.
**Rejected because:** Unbounded buffer growth between alarm flushes. At 60s flush
cadence and rapid Q&A, the buffer could accumulate dozens of rows. The cap keeps
SQLite storage predictable.

**Alternative considered:** Cap in the alarm (DELETE oldest after flush).
**Rejected because:** The alarm operates on all rows — it would flush ALL turns
to D1, then delete all but 8. This wastes D1 writes. Better to cap BEFORE the
flush, so only 8 rows per cycle hit D1.

### 8.3 Why fire-and-forget write (not synchronous)

**Decision:** The Worker appends turns to the DO buffer AFTER `chat()` returns,
using `ctx.waitUntil()` for lifetime extension. The HTTP response doesn't wait
for the append.

**Alternative considered:** Synchronous append before returning the reply.
**Rejected because:** Adds ~10-20ms latency to every chat response. The student
waits longer for no visible benefit — the reply is already generated. Buffer
loss is acceptable per Alpha's spec.

### 8.4 Why `conversationBuffer` and `history` are separate fields

**Decision:** Two fields on `ChatOptions`: `conversationBuffer` (from DO, authoritative)
and `history` (from Beauty widget, fallback).

**Alternative considered:** Merge them in the Worker and pass a single `history`
array to `chat()`.
**Rejected because:** `chat()` should know the provenance. The DO buffer has
persisted turns from prior requests; the widget's `history` is ephemeral (lost
on page refresh). If both are present, the DO wins. If `chat()` receives a
single merged array, it can't make that decision. Also: the DO buffer carries
`created_at` timestamps (useful for "when did I ask that?" context); the widget's
`history` doesn't.

### 8.5 Why contextualize in code, not in the prompt

**Decision:** `contextualizeQuery()` is a pure function that rewrites the user
message before it reaches the LLM. The LLM sees the resolved query, never raw
history + a "figure out what 'it' refers to" instruction.

**Rationale:** Same principle as signature lookup — deterministic reference
resolution belongs in code. The LLM is a wordsmith, not a reference resolver.
This is AGENTS.md §5 rule 6 applied to conversation context.

### 8.6 Alarm flush behavior — buffer cleared on flush

**Decision:** `conversation_buffer` follows the `alert_buffer` pattern: after
flush to D1, rows are DELETEd from the local buffer. The next turn starts with
an empty buffer and re-populates it.

**Implication:** If a student pauses >60 seconds between turns, the buffer is
empty and "why?" gets a single-turn response. This is acceptable — the student
will naturally re-anchor with a fuller question after a long pause. The
alternative (exempting `conversation_buffer` from DELETE, like `telemetry_buffer`)
is a one-line alarm change if Alpha decides it's warranted.

---

## 9. What This Design Does NOT Cover

| Out of scope | Why |
|---|---|
| Semantic vector retrieval | Deferred until Alpha green-lights conversational/tutor mode |
| Cross-session context ("last week you asked...") | Requires D1 `chat_history` query + session identity. Design exists but not prioritized. |
| Device-type gating on retrieval path | micro:bit has no disturbances. The retrieval architecture supports gating; implementation waits on multi-device rollout. |
| Conversational voice per signature | Researcher still owes per-signature voice lines. Qwen synthesizes acceptable voice from rich scenario descriptions in the interim. |
| `chat_history` D1 query from `chat()` | `chat()` does not query D1 directly (layer contract). If cross-session context is prioritized later, the Worker queries D1 and passes results via a new `opts` field. |

---

## 10. Summary — What Edge Needs to Build

| # | What | Where | Pattern to follow |
|---|---|---|---|
| 1 | `conversation_buffer` table | DO migration (id: 8) | `alert_buffer` migration (id: 4) |
| 2 | `_flush_registry` registration | Constructor | `alert_buffer` registration (line 160) |
| 3 | `GET /do-conversation-buffer` | `fetch()` in device-hub.ts | `/do-recent-alerts` (line 272) |
| 4 | `POST /do-conversation-append` | `fetch()` in device-hub.ts | New — but follows existing endpoint structure |
| 5 | `chat_history` table + index | D1 migration (0006) | `alerts` table (0004) |
| 6 | DO buffer read in chat route | `index.ts` POST /api/chat | `/do-recent-alerts` read (lines 282-290) |
| 7 | DO buffer write in chat route | `index.ts` POST /api/chat | New — fire-and-forget after `chat()` returns |
| 8 | Pass `conversationBuffer`, `history`, `focus` to `chat()` | `index.ts` chat call | Existing `liveAlerts` pass (line 298) |

**Zero alarm code changes.** The `_flush_registry` pattern handles the new table
automatically. The alarm's `PRAGMA table_info` → generic `INSERT` works because
buffer columns match D1 columns.

---

*Agent AI — 2026-07-14 (updated 2026-07-17 to reflect Edge deployment + chat.ts code shipped)*

// FunConnect — Natural-language layer over Madgwick-enriched disturbance alerts.
//
// RAG, not agent (the "puppet theater"): the model never queries a database,
// calls a tool, or decides anything. It receives structured alert data we
// already computed and wordsmiths it into plain language for a primary-school
// classroom. Watching is free; inference is metered — so we fetch + select +
// format here (cheap) and hand the model the smallest possible context.
//
// Pipeline (one function):
//   1. detect intent from the child's question   (pure)
//   2. fetch last N enriched alerts from D1       (one indexed read)
//   3. enrich + rank by relevance to the question (pure)
//   4. format a token-tight prompt                (pure)
//   5. call an LLM through a swappable provider   (metered)
//   6. return { reply, context }
//
// Audience: 10-year-olds and their teachers. No math, no JSON, no `a_trans`
// unless the child explicitly asks. The Madgwick output is invisible.
//
// The `ai` binding (Workers AI, Llama 3.2 3B) is the default provider and needs
// no API key — the FunConnect token already carries "Workers AI — Read". To
// swap to an external provider (DashScope Qwen), pass `opts.provider`.

// ── Public contract ──────────────────────────────────────────────────────────

/** One enriched alert as returned to the caller (Beauty renders these). */
export interface AlertContext {
  id: number;
  device_id: string;
  event: string | null;
  classification: Classification;
  impact_g: number;            // |a_trans| = √(x²+y²+z²), translational peak in g
  roll: number;                // degrees at end of window
  pitch: number;               // degrees at end of window
  freefall: boolean;
  orientation: string;         // humanized: "flipped nearly upside down", …
  ago: string;                 // humanized: "3 minutes ago"
  at_ms: number;               // event time (epoch ms) for the UI to sort/format
  /** Signature integer (0–63) from the disturbance detector's coarse bit-code.
   *  null when the alert predates the signature column or comes from a device
   *  that doesn't emit signatures (e.g. micro:bit). */
  signature: number | null;
  /** Pre-resolved signature name, e.g. "Side-angle hit". null when signature is
   *  absent or out of range. Resolved in code, not in the prompt. */
  signature_name: string | null;
  /** Pre-resolved signature family, e.g. "corner". Drives Madgwick gating and
   *  lets Beauty filter/group alerts by family. */
  signature_family: string | null;
  /** Human-scale comparison, e.g. "a solid shove, like a book falling flat".
   *  Resolved from |a_trans| via the baseline reference table (§11.6). */
  baseline_comparison: string;
  /** Impact direction in plain language, e.g. "from the right side, slightly
   *  from below". Resolved from the a_trans vector (§11.5). */
  impact_direction: string;
}

export interface ChatResult {
  reply: string;
  context: AlertContext[];
}

export type Classification =
  | "crash" | "bump" | "tilt" | "freefall" | "vibration" | "unknown";

/** Pluggable LLM backend. Default is Workers AI; swap for DashScope etc.
 *  `opts.think` requests reasoning mode (honored by providers that support it). */
export interface LLMProvider {
  generate(system: string, user: string, opts?: { think?: boolean }): Promise<string>;
}

export interface ChatOptions {
  /** Override the LLM backend. Default: Workers AI via the `ai` binding. */
  provider?: LLMProvider;
  /** Workers AI model id (ignored when `provider` is supplied). */
  model?: string;
  /** How many recent alerts to fetch from D1 for ranking. Default 25. */
  fetchLimit?: number;
  /** How many alerts to feed the model as context. Default 5. */
  contextLimit?: number;
  /** Scope the query to one device. Default: most recent across all devices. */
  deviceId?: string;
  /** Cap on generated tokens. Default 300 (a few friendly sentences). */
  maxTokens?: number;
  /** Enable auto-thinking: reason on analytical questions. Default false —
   *  reasoning adds ~30s latency and little value with thin context today. */
  autoThink?: boolean;
  /** Live alerts from the DO buffer (not yet flushed to D1). Merged ahead of D1
   *  history so a just-happened event surfaces even if the flush alarm is dead. */
  liveAlerts?: Array<{
    device_id: string;
    event?: string | null;
    signature?: number | null;
    do_ms?: number | null;
    madgwick_json?: string | null;
  }>;
  /** Conversation buffer from DO-local SQLite — prior turns for THIS device.
   *  Provides conversational grounding for follow-up resolution.
   *  Absent → single-turn mode (backwards compatible). */
  conversationBuffer?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  /** Prior turns from Beauty's widget (oldest→newest), capped at 8 turns.
   *  Fallback when the DO buffer is empty. When both are present,
   *  conversationBuffer wins — the DO is authoritative. */
  history?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  /** Focus context for drill-in. When a user taps a context chip in Beauty,
   *  this grounds the response on a specific event. Drives keyed exact lookup.
   *  Backwards compatible: absent → no drill-in. */
  focus?: {
    alert_id: number;
    signature?: number;
  };
}

/** One block from the text corpus — a physics explanation or signature
 *  reference retrieved via FTS5 full-text search. */
export interface CorpusBlock {
  title: string;
  content: string;
  tier: 'triage' | 'signature' | 'physics';
  family: string | null;
  signature: number | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
const DEFAULT_FETCH_LIMIT = 25;
const DEFAULT_CONTEXT_LIMIT = 5;
const DEFAULT_MAX_TOKENS = 300;

// ── Keyed reference data (compiled from Researcher's canonical sources) ────────
// Source: Researcher/signature-map.json v1.0.0 (stable since 2026-07-13)
// Source: Researcher/RESEARCHER.md §11.5 (axes-to-language), §11.6 (baseline table)

type MadgwickGating = 'confirm_near_zero' | 'optional' | 'important'
  | 'important_on_no_gyro' | 'required' | 'confirms_severity_only';

interface SignatureEntry { name: string; family: string; }

/** O(1) lookup by signature integer (0–63). */
const SIGNATURE_MAP: Record<number, SignatureEntry> = {
  0:  { name: "Silent trigger",            family: "noise" },
  1:  { name: "Desk spin",                 family: "spin" },
  2:  { name: "Forward nod",               family: "spin" },
  3:  { name: "Diagonal wobble",           family: "spin" },
  4:  { name: "Side rock",                 family: "spin" },
  5:  { name: "Coin wobble",               family: "spin" },
  6:  { name: "Table jiggle",              family: "spin" },
  7:  { name: "Brief jolt",                family: "spin" },
  8:  { name: "Clean drop",                family: "drop" },
  9:  { name: "Drop with spin",            family: "drop" },
  10: { name: "Edge drop",                 family: "drop" },
  11: { name: "Corner drop",               family: "drop" },
  12: { name: "Side-edge drop",            family: "drop" },
  13: { name: "Corner drop with roll",     family: "drop" },
  14: { name: "Flat-edge drop",            family: "drop" },
  15: { name: "Hard drop",                 family: "drop" },
  16: { name: "Short-side tap",            family: "bump" },
  17: { name: "Short-side clip",           family: "bump" },
  18: { name: "High side-nudge",           family: "bump" },
  19: { name: "Short-side slam",           family: "bump" },
  20: { name: "Side rock",                 family: "bump" },
  21: { name: "Rolling side-hit",          family: "bump" },
  22: { name: "Tumbling side-hit",         family: "bump" },
  23: { name: "Violent side-hit",          family: "bump" },
  24: { name: "Diagonal tap",              family: "corner" },
  25: { name: "Diagonal corner clip",      family: "corner" },
  26: { name: "Diagonal nose-hit",         family: "corner" },
  27: { name: "Diagonal corner slam",      family: "corner" },
  28: { name: "Diagonal roll-hit",         family: "corner" },
  29: { name: "Diagonal roll-spin",        family: "corner" },
  30: { name: "Diagonal tumble",           family: "corner" },
  31: { name: "Diagonal crash",            family: "corner" },
  32: { name: "Long-side tap",             family: "bump" },
  33: { name: "Side-swipe",                family: "bump" },
  34: { name: "High push",                 family: "bump" },
  35: { name: "Pitching side-hit",         family: "bump" },
  36: { name: "Rolling push",              family: "bump" },
  37: { name: "Rolling side-swipe",        family: "bump" },
  38: { name: "Tumbling push",             family: "bump" },
  39: { name: "Violent side-swipe",        family: "bump" },
  40: { name: "Diagonal tap",              family: "corner" },
  41: { name: "Diagonal clip",             family: "corner" },
  42: { name: "Nose-down hit",             family: "corner" },
  43: { name: "Nose-down slam",            family: "corner" },
  44: { name: "Side-angle hit",            family: "corner" },
  45: { name: "Side-angle spin",           family: "corner" },
  46: { name: "Side-angle tumble",         family: "corner" },
  47: { name: "Diagonal crash",            family: "corner" },
  48: { name: "Flat corner tap",           family: "corner" },
  49: { name: "Flat corner clip",          family: "corner" },
  50: { name: "Corner pitch-hit",          family: "corner" },
  51: { name: "Corner pitch-spin",         family: "corner" },
  52: { name: "Corner roll-hit",           family: "corner" },
  53: { name: "Corner roll-spin",          family: "corner" },
  54: { name: "Corner tumble",             family: "corner" },
  55: { name: "Flat crash",                family: "corner" },
  56: { name: "Ghost crash",               family: "ghost" },
  57: { name: "Triaxial yaw-crash",        family: "crash" },
  58: { name: "Triaxial pitch-crash",      family: "crash" },
  59: { name: "Triaxial pitch-spin crash", family: "crash" },
  60: { name: "Triaxial roll-crash",       family: "crash" },
  61: { name: "Triaxial roll-spin crash",  family: "crash" },
  62: { name: "Cartwheel crash",           family: "crash" },
  63: { name: "Full crash",                family: "crash" },
};

/** Madgwick gating flag per family — governs how much the LLM trusts the coarse
 *  bits vs. the Madgwick fusion when narrating an event. */
const FAMILY_GATING: Record<string, MadgwickGating> = {
  noise:   "confirm_near_zero",
  spin:    "optional",
  drop:    "important",
  bump:    "important_on_no_gyro",
  corner:  "important_on_no_gyro",
  ghost:   "required",
  crash:   "confirms_severity_only",
};

interface BaselineBand { maxG: number; human: string; robot: string; }

/** Ordered low→high. First band whose maxG >= |a_trans| wins. */
const BASELINE_TABLE: BaselineBand[] = [
  { maxG: 0.2, human: "below the sensor noise floor — probably benign",
    robot: "Probably benign" },
  { maxG: 0.5, human: "a gentle tap with a fingertip",
    robot: "Desk bump, cable snag" },
  { maxG: 1.0, human: "a firm poke",
    robot: "Dropped from 2–5 cm" },
  { maxG: 2.0, human: "a solid shove, like a book falling flat",
    robot: "Dropped from 10–20 cm, wall bump at low speed" },
  { maxG: 3.0, human: "like a book falling flat",
    robot: "Dropped from 30–50 cm, moderate-speed collision" },
  { maxG: 5.0, human: "a hard fall from desk height",
    robot: "Dropped from 1m+, high-speed wall hit" },
  { maxG: Infinity, human: "a violent impact",
    robot: "Thrown, kicked, or fell from >2m" },
];

// ── Corpus retrieval (FTS5) ───────────────────────────────────────────────────
// "Resolve in code, not in the prompt" — deterministic lookup of relevant
// physics passages. The FTS5 index lives in D1 (Edge migration 0007); chat()
// queries it for curiosity questions that don't match any disturbance keywords.

/** Detect whether a question is a curiosity/learning question rather than an
 *  event-recall question. Returns true when the student is asking about physics,
 *  concepts, or how things work — not about what the robot felt.
 *
 *  Rules (order matters):
 *   1. If intent.classes has disturbance keywords → about events, not curiosity.
 *   2. If it's a bare greeting ("hi", "hello") → chat, not curiosity.
 *   3. If ≥5 words and no event classes → likely curiosity.
 *   4. If short but contains technical keywords → curiosity.
 *   5. Otherwise → not curiosity (treat as ambiguous event question). */
export function isCuriosityQuestion(message: string, intent: Intent): boolean {
  // Event questions — matched disturbance keywords.
  if (intent.classes.size > 0) return false;
  // Pure greetings are neither curiosity nor event questions.
  if (/^(hi|hello|hey|good\s(morning|afternoon|evening)|sup|yo|howdy|greetings)[!.\s]*$/i.test(message.trim())) return false;
  // Common event questions that don't necessarily match disturbance keywords.
  // "what happened", "is it ok", "anything new" — clearly about device state.
  if (/\bwhat\s+happened|what\s+did\s+it\s+(feel|do)|is\s+(it|my\s+robot|the\s+robot)\s+ok|what\s+just\s+happened|anything\s+new|any\s+(updates|news|bumps)|tell\s+me\s+what|how\s+is\s+(it|my\s+robot|the\s+robot)\b/i.test(message)) return false;
  const words = message.trim().split(/\s+/);
  // Substantial question without event keywords → curiosity.
  if (words.length >= 5) return true;
  // Short technical question → curiosity.
  return /\b(madgwick|quaternion|filter|fusion|gimbal|sensor|imu|accelerometer|gyroscope|algorithm|math|physics|matrix|vector|beta|adaptive|ahrs|orientation|euler|rotation|freefall|explain|how\s+does|what\s+is|what\s+are|definition|meaning)\b/i.test(message);
}

/** Detect whether a curiosity question is technical — the student wants deeper
 *  explanations with math/physics concepts, not just kid-friendly analogies. */
export function isTechnicalQuery(message: string): boolean {
  return /\b(madgwick|quaternion|filter|fusion|gimbal|matrix|vector|beta|adaptive|ahrs|gradient|jacobian|derivative|integral|algorithm|sensor\s*fusion|rotation\s*matrix|euler\s*angle)\b/i.test(message);
}

/** Search the FTS5 corpus index for blocks matching the query.
 *  Returns top-N blocks ranked by BM25 relevance.
 *
 *  FTS5 uses implicit AND between words in a MATCH query — "what is a
 *  quaternion" requires all four words to appear in the matched row, which
 *  fails because common words like "what" and "is" rarely appear in physics
 *  corpus blocks.  We strip stop words and join the remaining content terms
 *  with OR so "quaternion" alone is sufficient to match.
 *
 *  Returns empty array on any error (graceful degradation). */
export async function searchCorpus(
  db: D1Database,
  query: string,
  limit: number = 3,
): Promise<CorpusBlock[]> {
  // Strip FTS5 special characters — keep only word characters and spaces.
  const safe = query.replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!safe || safe.length < 2) return [];
  const ftsQuery = buildFtsQuery(safe);
  try {
    const stmt = db.prepare(
      `SELECT title, content, tier, family, signature, rank
       FROM corpus_fts
       WHERE corpus_fts MATCH ?1
       ORDER BY rank
       LIMIT ?2`
    ).bind(ftsQuery, limit);
    const res = await stmt.all<CorpusBlock & { rank: number }>();
    return (res.results ?? []).map((r) => ({
      title: r.title,
      content: r.content,
      tier: r.tier,
      family: r.family ?? null,
      signature: r.signature ?? null,
    }));
  } catch {
    return [];
  }
}

/** Stop words stripped from FTS5 queries so implicit AND doesn't kill
 *  matches.  "what is a quaternion" → "quaternion" → MATCH works. */
const STOP_WORDS = new Set([
  "what", "is", "a", "an", "the", "how", "does", "do", "did",
  "why", "explain", "tell", "me", "about", "can", "you", "i",
  "we", "it", "in", "on", "of", "to", "for", "and", "or",
  "that", "this", "are", "was", "were", "be", "been", "have",
  "has", "had", "will", "would", "shall", "should", "may",
  "might", "must", "could", "not", "no", "so", "if", "then",
  "else", "when", "where", "who", "which", "there", "here",
  "just", "very", "really", "actually", "please",
]);

/** Sanitized query → FTS5-compatible OR query with stop words removed.
 *  "what is a quaternion" → "quaternion".
 *  "explain the Madgwick filter" → "madgwick filter".
 *  If all words are stop words, falls back to the full word list joined
 *  with OR — better to try a noisy match than return nothing. */
export function buildFtsQuery(sanitized: string): string {
  const words = sanitized.split(/\s+/).filter(w => w.length > 1);
  const content = words.filter(w => !STOP_WORDS.has(w.toLowerCase()));
  const terms = content.length > 0 ? content : words;
  return terms.join(" OR ");
}

/** Build a system prompt from corpus blocks for curiosity questions.
 *  The tone adapts: technical queries get deeper explanations with math;
 *  casual curiosity gets kid-friendly analogies.
 *
 *  The corpus blocks provide factual grounding — the LLM wordsmiths them
 *  into an age-appropriate explanation. It must not invent physics beyond
 *  what's in the passages. */
export function buildCorpusPrompt(
  message: string,
  blocks: CorpusBlock[],
  technical: boolean,
): string {
  const lines: string[] = [];
  lines.push(
    "You are FunConnect's friendly robot tutor, talking to a curious student.",
    "",
    `The student asked: "${message}"`,
    "",
    "Below are relevant passages from the robot's physics reference. Use them to answer the question accurately.",
  );

  if (technical) {
    lines.push(
      "",
      "TONE (technical — the student is ready for real concepts):",
      "- Explain in detail. Use the physics terms from the passages and explain what they mean.",
      "- Light math is OK when it helps understanding (simple equations, comparisons).",
      "- Still be friendly — you're a tutor, not a textbook. 3-5 substantive sentences.",
      "- End by asking if they want to go deeper on any part.",
    );
  } else {
    lines.push(
      "",
      "TONE (curious kid — keep it simple and fun):",
      "- Use everyday analogies the student already knows (bikes, balls, swings, phones).",
      "- No jargon unless you immediately explain it in plain words.",
      "- Connect the physics to something they can picture or feel.",
      "- 2-4 friendly sentences. Leave them curious to ask more.",
    );
  }

  lines.push(
    "",
    "RULES:",
    "- Only use information from the passages below. Never invent physics.",
    "- If the passages don't fully answer the question, say so honestly and suggest what they could ask instead.",
    "- Never mention \"the passages\" or \"the reference\" — just answer naturally.",
    "- You never run commands or make decisions. You only explain.",
    "",
    "PASSAGES:",
  );

  blocks.forEach((b, i) => {
    lines.push(`[${i + 1}] ${b.title}: ${b.content}`);
  });

  return lines.join("\n");
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function chat(
  message: string,
  db: D1Database,
  ai: Ai,
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const intent = detectIntent(message);

  // ── Curiosity path: FTS5 corpus search for physics/concept questions ──
  // Questions like "explain the Madgwick filter" or "what's a quaternion?" don't
  // match any disturbance keywords. They skip alert retrieval entirely — lighter,
  // faster, and the corpus gives better answers than alert context would.
  if (isCuriosityQuestion(message, intent)) {
    const blocks = await searchCorpus(db, message, 3);
    if (blocks.length > 0) {
      const technical = isTechnicalQuery(message);
      const system = buildCorpusPrompt(message, blocks, technical);
      const user = message.trim();
      const provider = opts.provider ?? workersAI(ai, opts.model, opts.maxTokens);
      const think = (opts.autoThink ?? false) && shouldThink(intent);
      let reply: string;
      try {
        reply = (await provider.generate(system, user, { think })).trim();
      } catch {
        reply = "I'd love to explain, but I'm having trouble looking up the answer right now. Try again in a moment!";
      }
      if (!reply) reply = "That's a fascinating question! Let me think... Actually, I don't have enough information to answer that properly. Try asking me what the robot felt instead!";
      return { reply, context: [] };
    }
    // No corpus hits — fall through to normal alert-based response.
  }

  // 1a. Contextualize bare follow-up questions using prior conversation turns.
  //     Resolves "why?" → "Previous conversation: ... Now the user is asking: why?"
  //     Pure function — no I/O, deterministic, testable without an LLM.
  const buffer = opts.conversationBuffer ?? opts.history ?? [];
  const contextualized = contextualizeQuery(message, buffer);

  // 1b. Fetch recent alerts. Merge the DO's live buffer (just-happened events not
  //    yet flushed — or stuck behind a dead alarm) AHEAD of D1 history, so a
  //    fresh bump is visible immediately regardless of the flush cycle.
  const d1Rows = await fetchAlerts(db, opts.deviceId, opts.fetchLimit ?? DEFAULT_FETCH_LIMIT);
  const liveRows: AlertRow[] = (opts.liveAlerts ?? []).map((a) => ({
    id: -1,
    device_id: a.device_id,
    event: a.event ?? null,
    signature: a.signature ?? null,
    created_at: a.do_ms ? Math.floor(a.do_ms / 1000) : null,
    do_ms: a.do_ms ?? null,
    madgwick_json: a.madgwick_json ?? null,
  }));
  const liveKeys = new Set(liveRows.map((r) => r.do_ms).filter((v) => v != null));
  const rows = [...liveRows, ...d1Rows.filter((r) => !liveKeys.has(r.do_ms))];

  // 2. Parse + enrich (pure). Bad/missing madgwick_json rows are dropped.
  //    Read the clock once and pass it in — do NOT `rows.map(enrichAlert)`,
  //    since map would feed the array index in as `nowMs`.
  const now = NOW();
  const enriched = rows
    .map((r) => enrichAlert(r, now))
    .filter((a): a is AlertContext => a !== null);

  // 3. Rank by relevance to the question, keep the top few for the context window.
  const selected = selectContext(enriched, intent, opts.contextLimit ?? DEFAULT_CONTEXT_LIMIT);

  // 4. Build the prompt. Context lives in the system prompt (it's data); the
  //    child's raw question is the user turn.
  const system = buildSystemPrompt(enriched, selected, intent, opts.focus);
  const user = contextualized.trim() || "What happened to my robot?";

  // 5. Inference. Auto-thinking: reason only for analytical questions; plain
  //    "what happened / is it okay" stays fast (thinking off).
  const provider = opts.provider ?? workersAI(ai, opts.model, opts.maxTokens);
  const think = (opts.autoThink ?? false) && shouldThink(intent);
  let reply: string;
  try {
    reply = (await provider.generate(system, user, { think })).trim();
  } catch {
    // Never surface a stack trace to a classroom. Degrade to a friendly note;
    // the context array still lets the UI show the underlying alerts.
    reply = fallbackReply(selected);
  }
  if (!reply) reply = fallbackReply(selected);

  return { reply, context: selected };
}

// ── D1 access ────────────────────────────────────────────────────────────────

interface AlertRow {
  id: number;
  device_id: string;
  event: string | null;
  signature: number | null;    // 0–63 coarse bit-code from the disturbance detector
  created_at: number | null;   // seconds (unixepoch)
  do_ms: number | null;        // event time, epoch ms
  madgwick_json: string | null;
}

async function fetchAlerts(
  db: D1Database,
  deviceId: string | undefined,
  limit: number,
): Promise<AlertRow[]> {
  const sql =
    `SELECT id, device_id, event, signature, created_at, do_ms, madgwick_json
       FROM alerts
      WHERE madgwick_json IS NOT NULL` +
    (deviceId ? ` AND device_id = ?1 ORDER BY COALESCE(do_ms, created_at*1000) DESC LIMIT ?2`
              : ` ORDER BY COALESCE(do_ms, created_at*1000) DESC LIMIT ?1`);
  const stmt = deviceId
    ? db.prepare(sql).bind(deviceId, limit)
    : db.prepare(sql).bind(limit);
  const res = await stmt.all<AlertRow>();
  return res.results ?? [];
}

// ── Keyed reference lookups (pure) ─────────────────────────────────────────────
// "Resolve in code, not in the prompt" — AGENTS.md §5 rule 6.
// These are deterministic lookups; the LLM receives only the resolved English.

/** O(1) lookup: signature integer → {name, family}. Returns null for out-of-range
 *  or missing signatures (the LLM gets no name rather than a wrong one). */
export function signatureInfo(sig: number | null | undefined): SignatureEntry | null {
  if (sig == null || sig < 0 || sig > 63) return null;
  return SIGNATURE_MAP[sig] ?? null;
}

/** |a_trans| magnitude → human-scale comparison string.
 *  Linear scan over the 7-band baseline table (constant time in practice). */
export function baselineFor(g: number): string {
  for (const b of BASELINE_TABLE) {
    if (g < b.maxG) return b.human;
  }
  return BASELINE_TABLE[BASELINE_TABLE.length - 1].human;
}

/** a_trans vector → plain-language impact direction.
 *  Per Researcher §11.5: dominant axis → direction label, with "slightly [second]"
 *  when the runner-up is >50% of the leader. Near-zero vectors return "no clear
 *  direction — the hit was too gentle to tell". */
export function impactDirection(ax: number, ay: number, az: number): string {
  const abs = { x: Math.abs(ax), y: Math.abs(ay), z: Math.abs(az) };
  const max = Math.max(abs.x, abs.y, abs.z);
  if (max < 0.05) return "no clear direction — the hit was too gentle to tell";

  // Determine dominant and second-strongest axes.
  const sorted = (["x","y","z"] as const).sort((a,b) => abs[b] - abs[a]);
  const dom = sorted[0], sub = sorted[1];

  const label: Record<string, string> = {
    x: ax > 0 ? "from the right side" : "from the left side",
    y: ay > 0 ? "from the front" : "from behind",
    z: az > 0 ? "from below (upward hit)" : "straight down",
  };

  // All three within 30% of each other → multi-directional.
  const min = Math.min(abs.x, abs.y, abs.z);
  if (min > max * 0.7) return "multi-directional impact";

  let out = label[dom];
  if (abs[sub] > max * 0.5) {
    // "slightly from below", "slightly from the left", etc.
    const subLabel = label[sub].replace(/^from /, "");
    out += `, slightly ${subLabel}`;
  }
  return out;
}

/** Family name → Madgwick gating flag. Governs how heavily the LLM weights the
 *  coarse bits vs. the Madgwick fusion when narrating an event. */
export function madgwickGating(family: string | null | undefined): MadgwickGating | null {
  if (!family) return null;
  return FAMILY_GATING[family] ?? null;
}

// ── Enrichment (pure) ────────────────────────────────────────────────────────

interface MadgwickJson {
  a_trans?: { x?: number; y?: number; z?: number };
  roll?: number;
  pitch?: number;
  freefall?: boolean;
  classification?: Classification;
}

/** Parse one row's madgwick_json into a UI-ready, humanized object. */
export function enrichAlert(row: AlertRow, nowMs = NOW()): AlertContext | null {
  let m: MadgwickJson;
  try {
    m = JSON.parse(row.madgwick_json ?? "");
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;

  const ax = num(m.a_trans?.x), ay = num(m.a_trans?.y), az = num(m.a_trans?.z);
  const impact_g = round2(Math.sqrt(ax * ax + ay * ay + az * az));
  const roll = round1(num(m.roll));
  const pitch = round1(num(m.pitch));
  const at_ms = row.do_ms ?? (row.created_at ? row.created_at * 1000 : nowMs);

  // Keyed reference lookups — resolved in code, not in the prompt.
  const sig = signatureInfo(row.signature);
  const dir = impactDirection(ax, ay, az);
  const baseline = baselineFor(impact_g);

  return {
    id: row.id,
    device_id: row.device_id,
    event: row.event,
    classification: normalizeClass(m.classification),
    impact_g,
    roll,
    pitch,
    freefall: m.freefall === true,
    orientation: describeOrientation(roll, pitch),
    ago: humanAgo(nowMs - at_ms),
    at_ms,
    signature: row.signature ?? null,
    signature_name: sig?.name ?? null,
    signature_family: sig?.family ?? null,
    baseline_comparison: baseline,
    impact_direction: dir,
  };
}

/** Roll/pitch → child-friendly orientation phrase. */
export function describeOrientation(roll: number, pitch: number): string {
  const tilt = Math.max(Math.abs(roll), Math.abs(pitch));
  if (tilt >= 150) return "flipped nearly upside down";
  if (tilt >= 100) return "rolled right over onto its side";
  if (tilt >= 55) return "tipped onto its side";
  if (tilt >= 25) return "leaned over quite a bit";
  if (tilt >= 10) return "tilted a little";
  return "stayed the right way up";
}

/** How hard the knock felt, in everyday terms (kept approximate). */
export function describeImpact(g: number): string {
  // Bands align with the classifier: crash fires at a_trans > 2.5 g. Alpha's
  // reference framing: ~2 g ≈ "catching a falling book".
  if (g < 0.3) return "a very gentle nudge";
  if (g < 1) return "a light tap";
  if (g < 2.5) return "a firm bump, like catching a falling book";
  if (g < 4) return "a hard knock";
  return "a big crash";
}

// ── Intent detection (pure) ──────────────────────────────────────────────────

export interface Intent {
  classes: Set<Classification>;  // classifications the question points at
  wantsCount: boolean;           // "how many times…"
  wantsNumbers: boolean;         // child explicitly asked for figures
  wantsWhy: boolean;             // "why did…"
  orientationFocus: boolean;     // "did it flip / fall over"
  wantsAnalysis: boolean;        // reason across events — triggers auto-thinking
}

const KEYWORDS: { re: RegExp; classes?: Classification[]; flag?: keyof Intent }[] = [
  { re: /\b(fell|fall|falling|drop|dropped|freefall|free[- ]?fall|air|airborne)\b/i, classes: ["freefall", "crash"] },
  { re: /\b(crash|crashed|smash|smashed|bang|banged|collide|collision|slam)\b/i, classes: ["crash"] },
  { re: /\b(bump|bumped|tap|tapped|knock|knocked|push|pushed|nudge|hit)\b/i, classes: ["bump", "crash"] },
  { re: /\b(shake|shaking|shook|vibrat\w*|wobble|wobbling|buzz|rattle)\b/i, classes: ["vibration"] },
  { re: /\b(tilt|tilted|lean|leaned|tip|tipped|slant)\b/i, classes: ["tilt"] },
  { re: /\b(flip|flipped|upside|over|rolled|topple|toppled)\b/i, flag: "orientationFocus" },
  { re: /\b(how many|how often|count|number of|times|total)\b/i, flag: "wantsCount" },
  { re: /\b(number|numbers|g[- ]?force|how many g|degrees|exact|data|value)\b/i, flag: "wantsNumbers" },
  { re: /\bwhy\b/i, flag: "wantsWhy" },
  { re: /\b(analy\w*|pattern|trend|repeat\w*|mishandl\w*|compare|overall|summar\w*|over time|history|each time|keep(s)? happening)\b/i, flag: "wantsAnalysis" },
];

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
  const words = message.trim().split(/\s+/);
  if (words.length > 5) return message;
  if (/\b(crash|bump|tilt|fall|shake|event|alert|signature)\b/i.test(message)) return message;

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

export function detectIntent(message: string): Intent {
  const classes = new Set<Classification>();
  const intent: Intent = {
    classes,
    wantsCount: false,
    wantsNumbers: false,
    wantsWhy: false,
    orientationFocus: false,
    wantsAnalysis: false,
  };
  for (const k of KEYWORDS) {
    if (!k.re.test(message)) continue;
    k.classes?.forEach((c) => classes.add(c));
    if (k.flag) (intent as Record<string, unknown>)[k.flag] = true;
  }
  return intent;
}

/** App-level "auto thinking": Qwen3 has no native auto (enable_thinking is
 *  boolean-only), so we decide here — reason only when the question asks to
 *  reason across events; simple recall stays fast and cheap. */
export function shouldThink(intent: Intent): boolean {
  return intent.wantsAnalysis;
}

// ── Context selection (pure) ─────────────────────────────────────────────────

/**
 * Rank alerts by relevance to the question, return the top `limit`.
 * Score = recency (newer wins) + a boost when the alert matches the question's
 * intent. Results stay in newest-first order so the model reads a timeline.
 */
export function selectContext(
  alerts: AlertContext[],
  intent: Intent,
  limit: number,
): AlertContext[] {
  if (alerts.length === 0) return [];
  const newest = alerts[0].at_ms;
  const oldest = alerts[alerts.length - 1].at_ms;
  const span = Math.max(1, newest - oldest);

  const scored = alerts.map((a, i) => {
    // Recency in [0,1]; index tiebreak keeps stable order for equal timestamps.
    let score = (a.at_ms - oldest) / span - i * 1e-6;
    if (intent.classes.has(a.classification)) score += 1.5;
    if (intent.orientationFocus && Math.max(Math.abs(a.roll), Math.abs(a.pitch)) >= 55) score += 1.0;
    if (intent.orientationFocus && a.freefall) score += 0.5;
    if (intent.wantsWhy && (a.classification === "crash" || a.freefall)) score += 0.5;
    return { a, score };
  });

  return scored
    .sort((p, q) => q.score - p.score)
    .slice(0, limit)
    .map((s) => s.a)
    .sort((p, q) => q.at_ms - p.at_ms); // present newest-first
}

// ── Prompt construction (pure) ───────────────────────────────────────────────

export function buildSystemPrompt(
  all: AlertContext[],
  selected: AlertContext[],
  intent: Intent,
  focus?: { alert_id: number; signature?: number },
): string {
  const lines: string[] = [];
  lines.push(
    "You are FunConnect's friendly robot helper, talking to primary-school children (about 10 years old) and their teachers.",
    "A small classroom robot reports whenever it feels a movement. Your job is to explain what it felt in warm, simple words.",
    "",
    "RULES:",
    "- Reply in 2-4 short sentences. Be kind, calm, and encouraging.",
    "- Use everyday words a 10-year-old knows. No jargon, no code, no JSON, and never words like \"a_trans\", \"quaternion\", or \"Madgwick\".",
    intent.wantsNumbers
      ? "- The child asked for figures, so you may include simple numbers (like \"about 2 g\" or \"nearly upside down\")."
      : "- Do NOT mention numbers, g-forces, or degrees unless the child explicitly asks. Describe things with feelings and comparisons instead.",
    "- Only talk about the events listed below. Never invent an event. If the list is empty, reassure them the robot has been calm and hasn't felt any bumps.",
    "- You never run commands or make decisions. You only explain, in friendly words, what already happened.",
    "",
    "WHAT THE ROBOT'S WORDS MEAN:",
    "- crash: a hard bump or crash, like being knocked off a desk.",
    "- bump: a gentle bump, tap, or push.",
    "- tilt: it was slowly leaned or tilted, with no real knock.",
    "- freefall: it was in the air for a moment — dropped or fell.",
    "- vibration: it was shaking or wobbling.",
    "- unknown: it felt something, but isn't sure what.",
    "Roughly: a light tap is under 1 g; a firm bump (like catching a falling book) is about 1-2.5 g; a hard knock is 2.5-4 g; a big crash is more than 4 g.",
  );

  if (intent.wantsCount) {
    lines.push("", "TALLY (last " + all.length + " reports): " + tally(all));
  }

  // Focus mode: drill-in on a specific event. Only show the focused alert.
  if (focus && selected.length > 0) {
    const focused = selected.find(a => a.id === focus.alert_id) || selected[0];
    lines.push(
      "",
      "FOCUSED EVENT (the user is asking about this specific event):",
      `[1] ${contextLine(focused)}`,
      "",
      "Only talk about this event. Do not mention other events or the full timeline."
    );
  } else {
    lines.push("", "ROBOT REPORTS (newest first):");
    if (selected.length === 0) {
      lines.push("(none — the robot has not reported any bumps recently.)");
    } else {
      selected.forEach((a, i) => lines.push(`[${i + 1}] ${contextLine(a)}`));
    }
  }
  return lines.join("\n");
}

/** One compact, model-facing line per alert. Pre-resolved facts only — the model
 *  wordsmiths, it does NOT do lookups. Numbers included for the model to reason
 *  over; whether they reach the child is governed by the RULES in the prompt. */
function contextLine(a: AlertContext): string {
  const parts = [
    a.ago,
    a.classification,
  ];
  // Signature name + family (resolved in code from signature-map.json).
  if (a.signature_name) {
    parts.push(`${a.signature_name} (${a.signature_family})`);
  }
  // Baseline comparison + impact direction (resolved in code from baseline table
  // and axes-to-language mapping).
  parts.push(`felt like ${a.baseline_comparison} ${a.impact_direction}`);
  // Orientation (resolved in code from roll/pitch).
  parts.push(a.orientation + ` (roll ${a.roll}°, pitch ${a.pitch}°)`);
  if (a.freefall) parts.push("was briefly in the air (freefall)");
  else parts.push("no freefall");
  // Raw numbers for the model to reason over (gated by RULES).
  parts.push(`(~${a.impact_g} g)`);
  return parts.join(" · ");
}

function tally(alerts: AlertContext[]): string {
  const counts = new Map<Classification, number>();
  for (const a of alerts) counts.set(a.classification, (counts.get(a.classification) ?? 0) + 1);
  const order: Classification[] = ["crash", "bump", "tilt", "freefall", "vibration", "unknown"];
  const parts = order
    .filter((c) => counts.get(c))
    .map((c) => `${counts.get(c)} ${c}${counts.get(c)! > 1 ? (c === "crash" ? "es" : "s") : ""}`);
  return parts.length ? parts.join(", ") : "no events";
}

/** Deterministic, friendly reply when the LLM is unavailable. */
export function fallbackReply(selected: AlertContext[]): string {
  if (selected.length === 0) {
    return "Good news — your robot has been calm and hasn't felt any bumps lately. It's happily online and waiting for its next adventure!";
  }
  const a = selected[0];
  const what =
    a.classification === "freefall" ? "took a little tumble through the air"
    : a.classification === "crash" ? "had a hard bump"
    : a.classification === "vibration" ? "did some shaking and wobbling"
    : a.classification === "tilt" ? "was tilted over gently"
    : "felt a small bump";
  const kind = a.signature_name ? ` (a "${a.signature_name}" event)` : "";
  const flip = a.orientation === "stayed the right way up" ? "" : ` It ${a.orientation}.`;
  return `Your robot ${what}${kind} ${a.ago}.${flip} Don't worry — robots are tough, and it's still doing just fine.`;
}

// ── LLM providers ────────────────────────────────────────────────────────────

/** Default provider: Cloudflare Workers AI (Llama 3.2 3B). No API key needed. */
export function workersAI(ai: Ai, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS): LLMProvider {
  return {
    async generate(system, user) {
      // `ai.run`'s model union is strict and version-dependent; the binding
      // itself is stable, so we localize the cast here and keep the rest typed.
      const out = (await (ai.run as unknown as (
        m: string,
        i: Record<string, unknown>,
      ) => Promise<{ response?: string }>)(model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.4,
      }));
      return out?.response ?? "";
    },
  };
}

/**
 * External provider: DashScope (Qwen) via its OpenAI-compatible endpoint.
 * Dormant until Alpha supplies an API key. Same interface — a drop-in swap:
 *   chat(msg, env.DB, env.AI, { provider: dashScope(env.DASHSCOPE_KEY) })
 */
export function dashScope(
  apiKey: string,
  cfg: {
    model?: string; endpoint?: string; maxTokens?: number;
    enableThinking?: boolean; thinkingBudget?: number;
  } = {},
): LLMProvider {
  const endpoint = cfg.endpoint
    ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";
  const model = cfg.model ?? "qwen3.7-plus";
  const maxTokens = cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
  // Qwen3 has no native "auto" thinking (enable_thinking is boolean-only), so the
  // caller decides per request via generate(..., { think }). Default off — this is
  // wordsmithing, the Madgwick pipeline already reasoned. When thinking IS on,
  // thinkingBudget caps reasoning tokens so it can't balloon to ~1.8k.
  const defaultThink = cfg.enableThinking ?? false;
  // No budget by default: on qwen3.7-plus, capping reasoning makes it spill its
  // working into the answer. Left unset → clean reply (reasoning stays in the
  // model's separate reasoning_content field, never shown to the child).
  const thinkingBudget = cfg.thinkingBudget;
  return {
    async generate(system, user, opts) {
      const think = opts?.think ?? defaultThink;
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.4,
        enable_thinking: think,
      };
      if (think) body.thinking_budget = thinkingBudget;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`DashScope ${res.status}`);
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return cleanReply(data.choices?.[0]?.message?.content ?? "");
    },
  };
}

// ── Small helpers ────────────────────────────────────────────────────────────

// Wrapped so tests can inject a fixed clock; production reads the real time.
function NOW(): number {
  return Date.now();
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function normalizeClass(c: unknown): Classification {
  const valid: Classification[] = ["crash", "bump", "tilt", "freefall", "vibration", "unknown"];
  return valid.includes(c as Classification) ? (c as Classification) : "unknown";
}

export function humanAgo(deltaMs: number): string {
  const s = Math.max(0, Math.round(deltaMs / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }

/** Strip any leaked reasoning from a reply. Reasoning models can emit a
 *  <think>…</think> block inline in the content field; keep only what follows
 *  the final </think> and drop any stray tags. */
export function cleanReply(s: string): string {
  const end = s.lastIndexOf("</think>");
  const body = end >= 0 ? s.slice(end + "</think>".length) : s;
  return body.replace(/<\/?think>/g, "").trim();
}

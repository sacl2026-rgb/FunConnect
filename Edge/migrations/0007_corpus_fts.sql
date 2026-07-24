-- 0007: corpus_fts — FTS5 full-text search over physics corpus.
-- Table created here; data seeded by AI/seed-corpus.mjs via D1 parameterized API.
-- Re-run  node AI/seed-corpus.mjs  after Researcher edits the corpus.

CREATE VIRTUAL TABLE IF NOT EXISTS corpus_fts USING fts5(
  title,
  content,
  tier,
  family,
  signature
);

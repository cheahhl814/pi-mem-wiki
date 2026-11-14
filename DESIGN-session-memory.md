# Design: Session memory pages + derived digest (pi-mem-wiki)

Status: proposal (review requested from implementation agent)
Date: 2026-11-14
Author: pi-mem-wiki maintainer (design extracted from 2026-11-14 design session)

## 0. Problem

Today the vault grows one small atomic page per `wiki_observe` call, written by
agent discretion, never compacted automatically. Measured state (2026-11):

- 2,411 files in `sources/`, of which 1,923 are `obs-*` pages; 751 created in the last 30 days.
- Consolidation (hub proposals, cold demotion) requires a manual `wiki_consolidate` + human apply; the 2026-11-12 proposal carried 29 cold items, 0 applied until 2026-11-14 (applied by hand: 22 accepted).
- Ambient recall is fine, but raw-obs volume dilutes ranking and forces reliance on manual curation.

Prior art survey (2026-11-14, see wiki page `concepts/observation-agent-memory-landscape-2026-no-clear-better-than-zosmaaipi-llm-wiki` and sources cited there) converges on the same pattern this design adopts:

- **Raw append-only logs → offline consolidation → small curated index.** Microsoft agent-framework (`MEMORY.md` ≤200 lines / ~25 KB + `topics/` + `transcripts/`; auto-consolidation gated on ≥5 sessions AND ≥24 h since last run, lock file with stale reclaim). mainbranch/auto-consolidation (24 h + 5 sessions + lock; absolute dates; "never edit logs"; index-as-pointer; measured ~9:1 compression, 5:1 floor).
- **Session-end consolidation as a shipped feature**: agentmemory v0.7.0, mnemory v1.9.0 (`raw` vs `consolidated` layers), Claude Code "auto-dream" (flag-gated), Letta Sleep-Time Compute + Context Repositories (git-backed markdown memory, MEMORY.md index, no vector DB).
- **Benchmarks are vendor-flavored** (Mem0 92.5 LoCoMo etc.) and irrelevant to vault sizing; the win here is architectural.

Take-away adopted: raw per-session capture is fine as an archive; consolidation is what keeps the vault healthy; the digest — not the raw pages — is the recall citizen.

## 1. Goals / non-goals

Goals:
1. One **immutable raw page per session** carrying the session's atomic claims, written once, never edited.
2. A **derived, per-workspace digest page** rebuilt by a gated compaction process — homogeneous, small, recall-friendly.
3. Automatic **cold demotion** of compacted raw pages (frontmatter-only, reversible, no human gate — same risk class as existing cold apply).
4. Zero regression to existing vaults that do nothing (feature-flagged).

Non-goals:
- No deletion, ever. Cold only.
- No rewriting of existing pages.
- No change to `wiki_observe` semantics for existing callers (kept; new path is separate).
- Not a handoff replacement. Handoff = resume narrative for the next agent (workspace-local). This = durable, cross-session recall. They may cross-link, nothing more.
- Not a migration of existing 1,900+ obs pages (a later, separate, budgeted pass).

## 2. Data model

### 2.1 Raw session page

Path: `sessions/<workspace-slug>/<yyyy-mm-dd>-<short-session-id>.md`
(`<workspace-slug>` = the same slug the wiki already derives from the vault root; honour `llm-wiki.projectId` when set.)

Frontmatter:
```yaml
type: session
workspace: <slug>
session_id: <id-or-date-seq>
created: 2026-11-14T...
closed: 2026-11-14T...        # set exactly once at freeze
lifecycle: raw                 # raw → (digest consumes) → cold
```

Body grammar (strict, one claim per section, heading is the claim):
```markdown
## decision: cold-apply 22 observation pages, reject 20 hubs
Chose proposal P-2026-11-12-0720 split … (source: session exit)

## fact: cold-apply applied 2026-11-14; 22 pages
…

## open: does auto-apply gate count confirmed rounds or proposal rounds?
…

## todo: re-run weekly consolidate after auto-apply unlocks
…

## note: handoff.md is the session state of record
…
```
Section types: `decision:`, `fact:`, `open:`, `todo:`, `note:`. Anything not fitting is dropped at write time — noise is the enemy.

Invariant: after `closed` is set, the file is never rewritten. Corrections happen in the **next** session's page (`corrects:` field optional).

### 2.2 Digest page

Path: `digests/<workspace-slug>.md` (one per workspace)

Frontmatter:
```yaml
type: digest
workspace: <slug>
updated: <iso>
digested_through: <iso of newest raw page consumed>
raw_pages_consumed: <int>
lifecycle: active
```

Body: single `## Decisions`, `## Facts`, `## Open`, `## Watchlist` sections; every bullet dated, resolved opens removed (not struck through), relative dates converted to absolute. Hard cap ~200 lines / ~25 KB (lint-enforced). If exceeded, oldest material rolls to `digests/<workspace>-archive-<n>.md` (type `digest`, still recallable, marked `archived: true`), digest keeps only live + last N months.

### 2.3 Raw pages are not recall citizens

Ambient recall never injects raw session pages. Explicit `wiki_recall` surfaces them only with `include_raw: true`. QMD/lexical search may index them (cheap, provenance-friendly). Digest pages participate in normal ranking — they are small, homogeneous, high-signal, exactly what links-first wants to show.

## 3. Write path

Extension hook at `session_shutdown` (mirrors `handoff-auto`'s exit path):

1. If disabled (`llm-wiki.sessionPages.enabled`, default `false`) or vault not opted in → return.
2. Collect session material: transcript tail (bounded), `agent_settled` checkpoint if present (reuse handoff-auto's checkpoint idea; optional for v1).
3. One model call: "extract claims as typed sections" — output must match the grammar; on parse failure or timeout (~120 s), fall back to deterministic summary (file list + user messages only), flagged `summary_quality: fallback` in frontmatter. Never lose the session silently.
4. Write raw page, set `closed`. Append `consolidate-apply`-style event (`kind: "session-page"`).
5. **Never** rewrite, append to, or re-order an existing page after `closed` is set. (During the session, an optional `checkpoint()` may append — out of scope for v1.)

Explicit mid-session trigger: `wiki_observe` is unchanged; nothing in this design forbids using it. Raw session pages are additional, not a replacement. (If Dogfooding shows duplication pain, revisit.)

## 4. Compaction (digest build)

Gate (all required):
- ≥ 5 closed raw pages for the workspace with `created > digest.digested_through`, **and**
- ≥ 24 h since last digest build, **and**
- no live lock (`<vault>/meta/digest-<workspace>.lock`; stale > 30 min reclaimed).

Steps:
1. Acquire lock. Collect unconsumed raw pages (oldest first, cap N=50 per run).
2. Model call: merge raw sections into digest. Rules embedded in prompt: absolute dates, drop stale `open`/`todo` items or mark resolved when later raw pages settle them, dedupe against existing digest, never invent.
3. Write new digest atomically (tmp + rename). Set `digested_through`.
4. Cold-demote consumed raw pages via the **existing** apply machinery (`lifecycle: cold`, frontmatter-only) — extend the existing `wiki_apply_consolidate` cold path or a thin internal call; no new deletion/rewrite code.
5. Release lock, emit event, update `meta/index.md` via existing rebuild path.

Failure = nothing written. Partial failures (digest written, cold-demotion fails) are retried on next run using `digested_through` as the checkpoint; demotion is idempotent.

Trigger surfaces:
- Automatic: `turn_end` metadata pass notices gate satisfaction and dispatches a background job (same `dispatchReported` pattern as `wiki_consolidate`). Never blocks the user.
- Manual: `wiki_digest` command / tool with `--dry-run` and `--force`.
- Scheduled: the existing weekly check can call it (out of scope for v1 PR).

## 5. Non-negotiables (reject in review if violated)

- Raw pages: write-once; no API path rewrites them (test this).
- Digest build is all-or-nothing; any exception → no file writes, lock released.
- Cold demotion only via existing frontmatter path; no other mutation of source vault pages.
- Feature flag off ⇒ zero behavioral change to recall, registry, lint, or obs flow (test this).
- No new required dependency; model calls go through the existing task-config/embedder plumbing.

## 6. Implementation slices (independent, reviewable PRs or commits)

1. **Types + write path**: schema, slugging, session-page writer + unit tests. (No hooks yet; callable from a hidden `wiki_session_capture` tool for manual testing.)
2. **Recall/registry integration**: ambient exclusion, `include_raw` flag, digest ranking untouched, lint rule for raw-page immutability + digest size cap. Tests.
3. **Compaction**: gates + lock + digest writer + cold-demote hook + `--dry-run`. Tests with fixtures: empty vault, 4 sessions (gate refuses), 6 sessions (builds digest, demotes raw), concurrent lock, stale lock reclaim, model-failure atomicity.
4. **Exit hook**: `session_shutdown` wiring with the deterministic fallback; feature flag; docs.
5. *(Follow-up, not this PR)* backfill: bulk-digest the ~1,900 legacy obs pages in batches; costed separately.

Per-slice: `pnpm test`, `pnpm typecheck`, `pnpm lint` green. Keep the diff focused; no opportunistic refactors.

## 7. Open questions (resolve during review)

1. Vault location: project vault vs personal vault for raw pages + digest (suggest: project vault for both; personal raw only if `ambientPersonalVault`-like flag set).
2. Flag default: off until dogfooded? (Recommend yes.)
3. Digest cap enforcement: hard truncate vs archive-to-`-archive-N` (recommend archive).
4. Should raw pages be indexed in QMD? (Default yes; cheap; drop if it adds noise.)
5. Interaction with `handoff-auto`: cross-link both ways (session page records `handoff: <path>`; handoff may reference digest path). Keep loose; no coupling.
6. Token budget for the exit summarization call (recommend ≤ 4k output tokens, configurable).

## 8. Acceptance demo (for review)

With the flag on and a scratch vault:
1. Three scripted sessions → 3 raw pages appear; `wiki_recall` never returns them ambiently.
2. `wiki_digest --dry-run` prints planned demotions; run for real → digest exists, raw pages `lifecycle: cold`, `meta/events.jsonl` gains `kind: "session-digest"`.
3. `wiki_recall "<topic from session 1>"` returns the digest chunk, not the raw page.
4. Flag off → `pnpm test` green with zero session pages created anywhere.

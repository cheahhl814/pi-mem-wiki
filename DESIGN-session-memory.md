# Design: Session memory pages + derived digest (pi-mem-wiki)

Status: reviewed 2026-11-14 — see §8.1 for review amendments (they override earlier sections where they conflict)
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
(`<workspace-slug>` = `slugify(llm-wiki.projectId ?? basename(vault root))` — the ambient-recall project id, **always slugified** before it becomes a path segment; a verbatim `projectId` such as `../x` must never escape `sessions/`.)

Frontmatter:
```yaml
type: session
workspace: <slug>
session_id: <id-or-date-seq>
created: 2026-11-14T...
closed: 2026-11-14T...        # set exactly once at freeze
lifecycle: raw                 # raw → (digest consumes) → cold
scope: project:<slug>          # keeps shared vaults project-isolated under ambient scopeFilter
body_sha256: <hex>             # hash of the body at freeze; lint detects edits
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

Invariant: after `closed` is set, the body and every frontmatter field except `lifecycle` are immutable. The **only** permitted mutation is the single transition `lifecycle: raw → cold`, performed by compaction (§4 step 4). Corrections happen in the **next** session's page (`corrects:` field optional).

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
- ≥ 5 closed raw pages for the workspace with `closed > digest.digested_through`, **and** (keyed on `closed`, not `created`: a session that started before the last build but closed after it must still be consumed)
- ≥ 24 h since last digest build, **and**
- no live lock (`<vault>/.llm-wiki/meta/digest-<workspace>.lock`, i.e. `paths.meta`; stale > 30 min reclaimed).

Steps:
1. Acquire lock. Collect unconsumed raw pages (oldest first, cap N=50 per run).
2. Model call: merge raw sections into digest. Rules embedded in prompt: absolute dates, drop stale `open`/`todo` items or mark resolved when later raw pages settle them, dedupe against existing digest, never invent.
3. Write new digest atomically (tmp + rename). Set `digested_through` = max `closed` of the consumed pages.
4. Cold-demote consumed raw pages via the **existing** apply machinery (`lifecycle: cold`, frontmatter-only) — extend the existing `wiki_apply_consolidate` cold path or a thin internal call; no new deletion/rewrite code.
5. Release lock, emit event, update `meta/index.md` via existing rebuild path.

Failure = nothing written. Partial failures (digest written, cold-demotion fails) are retried on next run using `digested_through` as the checkpoint; demotion is idempotent.

Trigger surfaces:
- Automatic: `turn_end` metadata pass notices gate satisfaction and dispatches a background job (same `dispatchReported` pattern as `wiki_consolidate`). Never blocks the user.
- Manual: `wiki_digest` command / tool with `--dry-run` and `--force`.
- Scheduled: the existing weekly check can call it (out of scope for v1 PR).

## 5. Non-negotiables (reject in review if violated)

- Raw pages: write-once; no API path rewrites them (test this).
- Digest build is all-or-nothing up to and including the digest rename; any exception before it → no file writes, lock released. Cold demotion after the rename is a separate, idempotent step (see §4 "Partial failures").
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
1. Five scripted sessions → 5 raw pages appear; neither ambient recall nor default `wiki_recall` returns them (`include_raw: true` does). (Five, not three: the §4 gate refuses fewer than 5 without `--force`.)
2. `wiki_digest --dry-run` prints planned demotions; run for real → digest exists, raw pages `lifecycle: cold`, `meta/events.jsonl` gains `kind: "session-digest"`.
3. `wiki_recall "<topic from session 1>"` returns the digest chunk, not the raw page.
4. Flag off → `pnpm test` green with zero session pages created anywhere.

## 8.1 Review amendments

Recorded by the implementation review (2026-11-14). Scope is unchanged; these
pin down areas where the original text was unsound or under-specified.

1. **Shutdown time budget (unsound as written).** oh-my-pi caps every
   `session_shutdown` handler at 2000 ms (see `lib/runtime.ts`, upstream issue
   #263). A ~120 s model call cannot run there. The exit hook therefore races
   the summarizer against a host budget: pi → `sessionPages.summaryTimeoutSec`
   (default 120); omp → 1500 ms, so in practice omp sessions get the
   deterministic fallback. The fallback is written in-budget either way. A
   session is never lost, but omp sessions get the low-quality page.
2. **Write-once versus cold demotion.** These contradicted each other. Resolved in §2.1:
   the body and all frontmatter except `lifecycle` are frozen. `raw → cold` is the only
   transition. The writer refuses to clobber, using a hard-link no-clobber publish of a temp file.
   Lint verifies `body_sha256`. Agent-side edits through generic editing tools are
   *detected* (by lint) but not *blocked*. A tool_call guardrail for `wiki/sessions/**` is a
   follow-up, not v1.
3. **Resume and reload.** `reload` keeps the session alive, so no page is written.
   A resumed session that exits again reuses its session id. The filename gets
   a numeric suffix (`-2`, `-3`) and the second page re-summarizes the whole
   branch. Duplicated claims are accepted in v1, and the digest step dedupes them.
4. **"Existing apply machinery" is not directly reusable.** `applyConsolidate`
   is gated on a stored proposal plus a confirm token. Demotion instead uses the
   same frontmatter primitives (`readKnowledgeDocumentFile` →
   `patchKnowledgeDocument({lifecycle:"cold"})` → `writeKnowledgeDocumentFile`)
   via a small exported helper in `consolidate-apply.ts`. No other field is touched.
5. **Model plumbing.** "task-config/embedder plumbing" is read as: model via
   `Runtime.resolveModel` (honours `llm-wiki.taskModel`), call via the existing
   `runSubAgent` with a single `submit` tool. The embedder is for vectors and is
   not involved. Core functions take an injectable `complete()` so tests stay offline.
6. **Flag off really means off.** Registering a tool adds to every system prompt, so
   `wiki_session_capture` and `wiki_digest` are registered **only** when
   `llm-wiki.sessionPages.enabled` is true. This uses a factory-time gate, like `trajectories`.
   The recall exclusion keys on `type: session` **and** a `sessions/` path, so a
   pre-existing custom `session` type elsewhere is unaffected.
7. **Lint.** Session pages are archives by design. They are exempt from orphan
   findings, and nothing else about orphan detection changes. New findings cover
   a session-page body hash mismatch, an illegal `lifecycle`, and a digest over the cap.
8. **Open questions resolved.**
   - Q1: project vault by default. When cwd has no project vault, no page is written unless the separate personal fallback is on (see item 10).
   - Q2: off by default.
   - Q3: archive. On overflow, the oldest dated bullets move to `digests/<ws>-archive-<n>.md`.
   - Q4: no change. QMD indexes whatever it already indexes.
   - Q5: no cross-link in v1.
   - Q6: summarizer output is capped at 4096 tokens (the `runSubAgent` default).
9. **Known ceilings.** `closed` comparisons assume one clock; a vault shared
   across machines with skewed clocks can mis-order pages around a build. The lock is
   per workspace and per vault, not cross-host safe (same class as the existing
   last-writer-wins note for shared vaults).
10. **Personal-vault fallback (decided 2026-11-14, opt-in).** Most repos have no
    `.llm-wiki/`, so a second flag, `sessionPages.personalFallback` (default OFF,
    effective only together with `enabled`), lets session pages and digests go to
    the **initialized** personal vault when no project vault exists. The personal
    vault is never bootstrapped for this. `personalFallback` is honoured **only
    from user-level settings**: a cloned repo's `.pi`/`.omp` project settings
    cannot opt the user into writes to their personal vault. Project-level
    `enabled` still toggles capture once the user has opted in.
    - **Precedence:** a real project vault always wins, with its unchanged slug.
      `WIKI_HOME` counts as the personal vault, not as a project, even though
      `resolveProjectVaultRoot` reports it as a root. Without the fallback it gets no pages.
    - **Workspace slug:** `<slugify(basename(git toplevel))>-<6 hex of
      sha256(realpath(toplevel))>`. The toplevel is the nearest ancestor holding
      `.git` (a directory, or a file for worktrees and submodules), else the cwd. It is
      never `basename(home)`, which would collapse every repo into one workspace and
      one digest. The hash keeps same-named repos apart. `llm-wiki.projectId` is deliberately ignored here:
      set globally, it would recreate exactly that collapse.
    - **Scope consistency:** when the fallback is on and the personal vault is the
      ambient primary, the ambient `scopeFilter.projectId` is the same repo slug the
      writer stamps as `scope: project:<slug>`. Otherwise the ambient id is the
      pre-feature expression, byte for byte (`ambientScopeId`). Existing personal pages
      scoped `project:<home-basename>` stop matching ambiently in that configuration.
      Unscoped pages are unaffected.
    - **Residual risks (accepted, documented):**
      - *Shared-vault write contention:* concurrent sessions in different repos
        write to one vault. Page publish is no-clobber and the digest lock is per
        workspace, but `events.jsonl` appends and the metadata rebuild remain
        last-writer-wins, as for every other personal-vault write today.
      - *Explicit-recall noise:* the personal layer of `wiki_recall` ignores project
        scope by design, so every repo's digest is visible to explicit recall from any repo.
      - *Cross-harness visibility:* a personal vault shared through
        `WIKI_HOME`/`WIKI_ROOT` with MCP or other harnesses exposes
        transcript-derived text to them. Secret redaction runs before freeze, but it
        matches patterns and does not understand what it reads.
      - *Repo moves:* the key hashes the toplevel realpath, so moving or
        re-cloning a repo starts a new workspace (the old digest stays recallable).
        A 6-hex hash makes accidental collisions unlikely, not impossible.

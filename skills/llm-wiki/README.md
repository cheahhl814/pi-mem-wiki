# llm-wiki (pi-mem-wiki fork)

The skill the fork's Pi extension ships: how the agent should use its wiki tools
(`wiki_recall` at task start, `wiki_retro` at task end, capture/ingest/lint as
needed). The extension performs all mechanical work; the skill is the discipline
layer (synthesis + knowledge organization).

## Fork differences (pi-mem-wiki)

Read this skill together with the fork's docs:

- `../../docs/superpowers/roadmaps/fork-v3.md` — the fork roadmap (M0–M4)
- Fork tools beyond upstream: `wiki_consolidate` (proposal-only consolidation
  scan) and `wiki_apply_consolidate` (dry-run/confirm apply; confirm format
  `<proposalId>:<acceptCount>`; aborts on page drift; cold = frontmatter
  `lifecycle: cold` only, move-never-delete).
- Maintenance cadence: a weekly scheduled check
  (`pi-schedule` job `pi-mem-wiki-weekly`) leaves a waiting-note when a
  proposal has cold/supersede items; review/apply stays user-triggered.
- Semantic recall: keyless loopback embeddings (Ollama `bge-m3` at
  `http://localhost:11434/v1`); `wiki_status` shows coverage.

## Lint status

Linted by skill-forge `bin/skill-lint.py --include-vendored --profile tool-skill`:
0 FAIL as of 2026-10-29 (version/triggers/updated added in the fork; vendored
upstream file otherwise untouched).
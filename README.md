# pi-mem-wiki

[![Version](https://img.shields.io/badge/version-0.6.3--fork-blue)](#-installation)
[![Type](https://img.shields.io/badge/type-pi%20extension-blueviolet)](#-installation)
[![Tests](https://img.shields.io/badge/tests-1003%20passing-brightgreen)](#-hard-guarantees)
[![Built with](https://img.shields.io/badge/built%20with-skill--forge-orange)](https://github.com/cheahhl814/skill-forge)

Lifecycle-aware agentic memory for [pi](https://pi.dev) — a public, historied fork of
[`@zosmaai/pi-llm-wiki`](https://github.com/zosmaai/pi-llm-wiki) implementing
Andrej Karpathy's [LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
an Obsidian-compatible 4-layer vault (immutable source packets → editable wiki
pages → generated registry/journal → generated search index) where capture,
shelving, distillation, and staleness are tool-owned — not user chores.

**Repository**: https://github.com/cheahhl814/pi-mem-wiki

> [!NOTE]
> Current version: **v0.6.3-fork** (updated 2026-10-29). The fork ships v1
> (defect fixes) + v2 (lifecycle/consolidation) + M0–M3 ops, designed and
> Borda-ranked by a 3-seat multi-agent brainstorm and reviewed by a Claude /
> Opus seat; all changes upstreamed into this README.

## Contents

- [Installation](#-installation)
- [Usage](#-usage)
- [Fork features](#fork-features)
- [Consolidation workflow](#consolidation-workflow)
- [Local semantic recall](#local-semantic-recall)
- [Repository layout](#-repository-layout)
- [Hard guarantees](#-hard-guarantees)
- [Upstream rebase discipline](#upstream-rebase-discipline)
- [Provenance](#provenance)

## 🚀 Installation

This is a **Pi extension package**, not a user-facing library. Recommended: let your agent install it.

**Option A — give your agent this prompt (recommended):**

```text
Install the pi-mem-wiki extension from
https://github.com/cheahhl814/pi-mem-wiki —
clone it into your workspace, build it (npx tsc -p tsconfig.mcp.json),
and register it with your Pi agent (extension directory symlink or
package manifest entry). Then read skills/llm-wiki/SKILL.md and run
wiki_status to verify the vault resolves.
```

**Option B — manual:**

```bash
git clone https://github.com/cheahhl814/pi-mem-wiki.git
cd pi-mem-wiki
pnpm install --ignore-scripts
npx tsc -p tsconfig.mcp.json
```

**Via npm (once published):**

```bash
pi install npm:@cheahhl814/pi-mem-wiki
```

Standalone as an MCP server from Claude Code / Codex / Cursor:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/@cheahhl814/pi-mem-wiki/dist/mcp/index.js"]
    }
  }
}
```

## 💡 Usage

Driven by your AI agent; 17 wiki tools over Pi and MCP, 12 `/wiki-*` slash commands, and one shipped skill (`skills/llm-wiki`).

```text
run a consolidation round        # wiki_consolidate → review → wiki_apply_consolidate
check my memory's health         # wiki_status (health, ledger, embeddings, QMD)
what do I know about X           # wiki_recall (two-stage links-first, age-stamped)
remember this decision           # wiki_observe / wiki_retro (lifecycle-stamped)
```

Slash commands: `/wiki-init`, `/wiki-ingest`, `/wiki-query`, `/wiki-record`,
`/wiki-lint`, `/wiki-status`, `/wiki-retro`, `/wiki-req`, `/wiki-discover`,
`/wiki-digest`, `/wiki-skills`, `/wiki-run`.

## Fork features

| Feature | What changed vs upstream | Why |
|:--------|:-------------------------|:----|
| **Lint hardening** | Bare `[[token]]` links classified as tags (informational, never stub-able); `raw/**` targets informational; auto-page-creation gated to dry-run/confirm | Upstream auto-fix minted junk stub pages from tag-links (measured: 248 noise warnings → 37 real) |
| **Project scoping** | `scope: global \| project:<id>` frontmatter; ambient recall filtered by vault-root basename or explicit `llm-wiki.projectId` | Cross-project memory leakage; a cwd-basename guess breaks from subdirectories |
| **CJK / hybrid recall** | Lexical n-grams verified; `cjkQueryDegrades()` loud notice instead of silent empty recall; local keyless embeddings (loopback) | A CJK query is a structural lexical miss; measure (MRR 0.794 → 0.824) instead of assume |
| **Time semantics** | `stale_after` (OKF absolute-date form first, duration as fork extension), `valid_from`/`valid_until`/`superseded_by` consumed; ranked decay ×0.5/×0.1 applied after fusion; age-stamped results | Upstream declared the fields and never read them (#314); decay supersedes, never deletes |
| **Lifecycle ladder** | `lifecycle: captured → observed → promoted → archived \| cold`; cold pool decays ×0.1 with an `include_cold` escape hatch | Orphan-hood is a state, not an error; backlog drained via 3 real review rounds |
| **Proposal-only consolidation** | `wiki_consolidate` (machine items + page hashes) → `wiki_apply_consolidate` (dry-run default, confirm `<id>:<count>`, drift abort, move-never-delete, one journal event) | The highest-blast-radius automation stays human-gated; autonomy is measured (ledger), not granted |

## Consolidation workflow

```text
1. wiki_consolidate      → writes ONE proposal (machine items, per-page hashes)
2. review                → read the proposal + the machine item list
3. wiki_apply_consolidate (dry run)  → prints exact per-page changes, writes nothing
4. wiki_apply_consolidate (confirm "<proposalId>:<count>") → applies
```

Gates: cold = frontmatter flag only (never moves/deletes) · supersede requires
a named target (never guessed) · hubs created only on explicit accept ·
**merge/rewrite out of scope** · any drifted page aborts the whole apply ·
autonomy (`llm-wiki.autoApplyCold`) is OFF by default and opens only at
≥3 cold-bearing review rounds with ≥90% acceptance, capped 25/run.

## Local semantic recall

Zero-cost hybrid recall, nothing leaves the machine (fix: upstream required an
API key even for localhost):

```json
{
  "llm-wiki": {
    "embeddingProvider": "openai-compatible",
    "embeddingBaseUrl": "http://localhost:11434/v1",
    "embeddingModel": "bge-m3",
    "autoApplyCold": false
  }
}
```

`wiki_status` shows coverage (`Semantic embeddings: N/total, model bge-m3`);
if Ollama is down, recall falls back to lexical silently.

The generated QMD index under `meta/qmd/` is validated and rebuildable:
`wiki_reindex(scope="changed", components=["lexical", "vectors"])` for repair,
`wiki_reindex_embeddings` to embed an existing vault (see
[docs/architecture.md](./docs/architecture.md) — "generated and rebuildable").

## 📁 Repository layout

```text
pi-mem-wiki/
├── extensions/llm-wiki/         # Pi extension (entry: index.ts; lib/ modules)
├── skills/llm-wiki/             # Shipped agent skill (SKILL.md + README)
├── prompts/                     # /wiki-* slash command templates (mirrored to commands/)
├── mcp/                         # Standalone MCP server (6→17 tools, dist/mcp/index.js)
├── scripts/                     # mcp build, eval-vault.mjs, backfill-embeddings.mjs
├── test/                        # Vitest suite (89 files / 1003 tests + fork additions)
├── docs/                        # architecture, roadmap, benchmark, configuration
└── docs/superpowers/roadmaps/   # fork-v1 / fork-v3 roadmaps (design provenance)
```

## 🔒 Hard guarantees

- **Proposal-only writes in consolidation** — suggestions are never applied without a dry-run review plus an exact-count confirm; the harness mathematically refuses a mismatched confirm.
- **Move-never-delete** — cold/supersede set frontmatter state; files stay; history queries stay answerable.
- **Hash-drift abort** — a proposal whose pages changed since generation refuses to apply.
- **Journal everything** — proposals, applies, rejects and skips are `{kind:"consolidate*"}` events in the append-only `events.jsonl`; the autonomy ledger reads only that log.
- **Ranking-only decay** — stale/old pages are re-ranked, never dropped (explicit `include_cold` restores them).
- **Tested** — the fork adds 60+ regression tests on the upstream suite (1,003 passing), including the upstream retrieval benchmark baseline (upheld, not tuned against).

## Upstream rebase discipline

`upstream` remote (`zosmaai/pi-llm-wiki`) is preserved; rebase only between
milestones on a green gate. Watch upstream issues #314 / #171 / #303 — when
they land upstream, port the fork's versions over and re-test.
The [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
remains the pattern source; this repo is its lifecycle-aware implementation.

## Provenance

- **Forked from**: [`@zosmaai/pi-llm-wiki`](https://github.com/zosmaai/pi-llm-wiki) v0.12.5-lineage (MIT; upstream copyright preserved in `LICENSE`)
- **Design evidence**: 3-seat multi-agent brainstorm (Borda-ranked), Claude/Opus review integrated, live-vault dogfooding with a personal eval baseline (hit@5 0.824, MRR 0.824)
- **Built with**: [skill-forge](https://github.com/cheahhl814/skill-forge) README standard (repo-level adaptation)

## License

MIT — see [`LICENSE`](./LICENSE) (upstream copyright notice preserved as MIT requires).
# Fork v3 roadmap — pi-mem-wiki

Origin: Claude Code (opus) planning-seat brainstorm, 2026-10-29 (plan artifact:
`/tmp/llmwifork-v3-plan-claude.md`; this file is the adapted, committed version).
Grounded on fork-v1 @ c732dfe + a read-only look at the real `~/.llm-wiki`.

# pi-mem-wiki — v3 PLAN (Claude seat)

Grounded on fork-v1 @ c732dfe + a read-only look at `~/.llm-wiki` (2026-10-29).

**Verified facts this plan relies on**
- Vault: 2,101 `.md` under `wiki/`, 2,350 lines in `meta/events.jsonl`, **0** `consolidate` events, ~123 pages mention `lifecycle`. **The vault is not under git.** `config.json` still has `name/topic: "pending"`.
- `resolveEmbedder` (`lib/embeddings.ts:463`) **returns undefined when no API key is set**, even when `embeddingBaseUrl` points at localhost. Ollama needs no key, so today Ollama only works if you add a dummy key. That's a real gap for the "local default" idea.
- Ollama is installed, but **no embedding model has been pulled** (only chat models).
- `qmd_manifest_invalid` is thrown by `loadQmdManifest` validation (`lib/qmd-mirror.ts:89-181`). The mirror is derived data, so the fix is to rebuild it, not repair it.
- `consolidate.ts` writes a markdown proposal plus `discoveries/consolidate.json` holding **counts only**, not item lists. The proposal tells the applying agent to append `{kind:"consolidate-apply"}` by hand.
- The retrieval benchmark (`test/retrieval-benchmark.test.ts`) runs on a **synthetic fixture** with lexical `searchWiki` only. It has no cold/superseded/scope cases and no embeddings arm.

---

## VERDICT

| # | Idea | Call | Why (one line) |
|---|------|------|----------------|
| 8 | Real-vault ops | **v3 — M0, do first** | Nothing else can be judged until the fork runs against the real vault. |
| 2 | Local Ollama embeddings | **v3 — M1** | Biggest recall gain for the least code. Needs one small fix (keyless loopback) plus a docs default. |
| 6 | Retrieval benchmark | **v3 — folded into M1/M2 as the gate** | Not its own milestone. It's how we tell whether M1/M2 helped or hurt. |
| 5 | `wiki_apply_consolidate` | **v3 — M2** | Hand-editing 100 cold demotions across 2k pages is how a vault gets corrupted. |
| 1 | Autonomy ladder | **v3, measure only (M3). Auto-apply postponed** | Auto-apply needs an accept-rate, and an accept-rate needs ≥3 real reviewed rounds. v3 records the data and leaves the switch off. |
| 4 | Tag-namespace pages | **Postponed (v4 candidate)** | Generating ~N hundred `tags/*.md` pages adds recall noise and orphans. M2's human-accepted CLUSTER→hub pages cover the useful part. |
| 3 | Claim-level bi-temporal | **Dropped from v3** | Page-level time semantics just shipped and zero real pages use them yet. No evidence the claim level is needed. L effort and a schema change. |
| 7 | Watch upstream #314/#171/#303 | **Standing rule, not a milestone** | See the rebase discipline under ANTI-SCOPE / risks. |

---

## OPS-FIRST — shortest path to living in it

Run these in order. Steps 1–5 need no code. Steps 6–7 need M1 merged.

1. **Snapshot the vault.** Run `cd ~/.llm-wiki && git init && git add -A && git commit -m "pre-v3 baseline"`, or at minimum `tar czf ~/llm-wiki-$(date +%F).tgz ~/.llm-wiki`. Every later step writes to 2k pages, and today there's no undo. *(Strongly recommended. See Q1.)*
2. **Fill in the vault identity.** `config.json` `name`/`topic` are still `"pending"`. Set them by hand, and set `projectId` if scoping is wanted.
3. **QMD repair.** `mv ~/.llm-wiki/meta/qmd ~/.llm-wiki/meta/qmd.bak`, then let the extension rebuild the mirror (next `wiki_status`/turn_end, or the qmd reindex path). Do this from the user's shell: guardrails block agent edits under `meta/**`, which is intended. Delete `.bak` after one clean session. Separate issue: the Claude Code qmd MCP fails with ENOENT because `qmd` isn't on PATH. Cosmetic for pi, but it's an easy fix with a PATH symlink.
4. **Legacy-format repair, dry run first.** Run the existing `repairLegacyKnowledgeDocuments` path (`lib/legacy-repair.ts:527`) and `wiki_lint`. Commit the vault after it. Consolidation scoring assumes normalized frontmatter, so normalize before consolidating.
5. **Lexical baseline.** Write ~20 real queries you actually ask (mixed EN/CJK, include 3–4 paraphrases) to `~/.llm-wiki/outputs/eval-queries.json` with the expected page ids. Run recall and record hit@5. This file stays out of the public repo (personal vault).
6. **(M1 merged) Embeddings backfill.** `ollama pull bge-m3`, set config (see M1), run reindex in the background (~2.1k pages; local, minutes not hours). Re-run step 5 and compare.
7. **First consolidate round (M2 merged).** `wiki_consolidate` → read the proposal → `wiki_apply_consolidate` dry run → accept a **small** batch (≤25 cold demotions, 0 merges) → commit the vault → one week of dogfooding → next batch.
8. **Live dogfood.** Use pi daily for a week. The only metric that matters: "did recall surface the right thing without me asking twice?" Note misses in `outputs/eval-queries.json`, so they become the next eval set.

---

## ROADMAP

### M1 — Local vectors by default (+ real-vault eval) · **S**
**Goal:** Paraphrase and CJK↔EN recall works on the real vault with nothing leaving the machine.

**Deliverables (user-visible)**
- An `embeddingBaseUrl` on a loopback host (`localhost`, `127.0.0.1`, `::1`) no longer needs an API key. `resolveEmbedder` sends a placeholder bearer token. One guard in `resolveEmbedder`, not a new provider.
- The docs and the `/settings` hint recommend `embeddingProvider: "openai-compatible"`, `embeddingBaseUrl: "http://localhost:11434/v1"`, `embeddingModel: "bge-m3"`. bge-m3 is the choice because it's multilingual, so it handles CJK.
- `wiki_status` shows embedding coverage (`embedded N / total, model X`), so the backfill is visible.
- Tiny script `scripts/eval-vault.mjs <vault> <queries.json>` prints hit@5/MRR for lexical vs layered. It reuses `test/helpers/retrieval-metrics.ts`. No new framework.

**Risks → mitigations**
- *Ollama down mid-session:* recall must silently fall back to lexical. Already the case when the embedder throws; add a test to lock it in.
- *Model switch invalidates the store:* `isStale` already keys on model, so a switch means a full re-embed. Document it.
- *Loopback exemption widens trust:* only the keyless rule changes. Remote URLs still require a key.

**Tests**
- `resolveEmbedder` with a loopback URL and no key → defined. Remote URL with no key → undefined.
- Fetch rejects → layered recall still returns lexical results.
- Benchmark fixture: add 3 paraphrase queries and 2 CJK↔EN queries, run with a deterministic fake embedder so CI needs no Ollama. Update the baseline with `benchmark:retrieval:update`.

### M2 — `wiki_apply_consolidate` (dry-run → confirm, move-never-delete) · **M**
**Goal:** Turn a consolidate proposal into applied changes without hand-editing, safely and reversibly.

**Deliverables**
- `wiki_consolidate` also writes **machine-readable items** to `discoveries/consolidate.json`: `{id, action: "cold"|"supersede"|"hub", pages, reason}`. The apply step reads JSON and never parses markdown.
- New tool `wiki_apply_consolidate({ proposal_id, accept: string[] | "all-cold", reject?: string[], confirm?: boolean })`:
  - Without `confirm` → **dry run**. Prints the per-page frontmatter diff and writes nothing.
  - `cold` → sets `lifecycle: cold` in frontmatter. The file stays where it is. Nothing is moved or deleted.
  - `supersede` → sets `superseded_by` only when the user names a target. Otherwise it skips the item and says so. It does not guess a target.
  - `hub` → creates `wiki/<folder>/<tag>-hub.md` linking the cluster. Only when the hub is explicitly accepted.
  - **Merge is out of scope** (see ANTI-SCOPE).
  - Appends **one** `{kind:"consolidate-apply", proposal_id, accepted:[…], rejected:[…], skipped:[…]}` event, then triggers the metadata rebuild.
- Rejects a stale proposal: if any page hash changed since generation, abort with "re-run wiki_consolidate".
- Prompt and command template in `prompts/`, then run `pnpm build:commands`. Add to the MCP surface and update the 16→17 tool pin.

**Risks → mitigations**
- *Bulk frontmatter rewrite mangles YAML:* go through the existing `knowledge-document.ts` serializer, never string-splice. Add a round-trip test on a legacy-format page.
- *Agent passes confirm without showing the user:* `confirm` must name the proposal id plus the exact accepted count (`confirm: "P-…:25"`). A mismatch → refuse.
- *Undo:* every change is a frontmatter field (`lifecycle`, `superseded_by`), so reverting means removing the field. The event lists the exact ids. With the vault under git (Ops step 1), `git revert` works too.

**Tests**
- Dry run writes nothing (fs snapshot equality).
- Confirm with a mismatched count → refused.
- Cold apply → page still exists, same path, `lifecycle: cold`; recall ranks it ×0.1; `include_cold` returns it.
- Supersede with no target → skipped and reported.
- Hash drift → abort.
- Exactly one `consolidate-apply` event, with the ids.
- MCP parity pin is now 17 tools.

### M3 — Accept-rate ledger (autonomy ladder, measure-only) · **S**
**Goal:** Collect the evidence the autonomy ladder needs without granting any autonomy yet.

**Deliverables**
- `wiki_status` / dashboard shows **per-action accept-rate** across the last K rounds: accepted / (accepted + rejected) from `consolidate` + `consolidate-apply` events, plus a round count.
- An `autoApplyCold` config key exists but defaults to **off**. It is **refused** unless rounds ≥ 3 and cold accept-rate ≥ 0.9; the tool explains why. Even when allowed, it only ever applies `cold` (never supersede, hub, or merge), with a per-run cap of 25.
- `ponytail:` note in the code: "threshold is a guess; tune from real ledger after 3 rounds."

**Risks → mitigations**
- *Rubber-stamping inflates the accept-rate:* count only items the user saw in a dry run in the same session. "all-cold" counts as one decision, not N.
- *Metric gaming by the agent:* the rate is computed from the event log, which is append-only and not agent-editable (`meta/**` guardrail).

**Tests**
- Rate computation over a synthetic events.jsonl.
- Auto-apply refused under the threshold.
- Auto-apply never touches non-cold items.

### M4 — Fork-aware benchmark cases · **S**
**Goal:** Lock in that v1/v2 ranking changes (cold decay, supersession, time validity, scope) don't regress.

**Deliverables**
- Add benchmark fixture categories: `cold_demoted`, `superseded`, `expired_valid_until`, `project_scoped`, each with expected rank behavior. Refresh the baseline JSON.
- CI runs `benchmark:retrieval` (it's vitest, so it's already cheap).

**Risks:** baseline churn on upstream rebase → keep fork categories in a separate block of the fixture, so rebase conflicts stay local.

*Ordering note:* M4 is small enough to land alongside M1 if convenient. It's listed last because M1/M2 are what change the user's life.

---

## ANTI-SCOPE (refuse in v3)

- **Merge/rewrite of page bodies by consolidation.** It's lossy, LLM-authored, and hard to review across 2k pages. Move-never-delete only covers state transitions.
- **Any auto-apply beyond `cold`.** Supersede and hub stay human-gated forever unless the ledger argues otherwise in v4.
- **Claim-level fact objects.** Covered under VERDICT.
- **Auto-generated tag pages.** Postponed. Re-check after the first consolidation shows how many tags actually cluster.
- **New embedding providers or a vector DB.** OpenAI-compatible covers Ollama, LM Studio, and vLLM. The JSON embedding store is fine at 2k pages. Add a vector DB only past ~50k pages.
- **Deleting orphans.** About 1,000 orphans is a linking problem, not a deletion problem. Cold demotion plus hubs handle it.
- **Rebasing onto upstream mid-milestone.** Rebase only between milestones, on a green gate. Keep fork logic in fork-owned helpers (e.g. the `applyForkRanking` / options-object refactor flagged in the v1 review) to keep conflict surface small around #314/#171/#303.

---

## OPEN QUESTIONS (defaults in **bold**, so "defaults" works)

1. **Put `~/.llm-wiki` under a local git repo (no remote)?** → **Yes, local-only git, commit after each ops step / apply round.**
2. **Embedding model?** → **`bge-m3` via Ollama** (multilingual, CJK-capable). Fallback `nomic-embed-text` if RAM/latency hurts.
3. **First apply round size?** → **≤25 cold demotions, zero supersede/hub**, then a week of dogfooding before round 2.
4. **Hub pages: which folder?** → **The cluster's dominant folder** (`concepts/<tag>-hub.md`), not a new `hubs/` or `tags/` namespace.
5. **Eval queries file: committed anywhere?** → **No. It stays in the vault's `outputs/`**, since it's personal data. Only the synthetic fixture goes in the public repo.

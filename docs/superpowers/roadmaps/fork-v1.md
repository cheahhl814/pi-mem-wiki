# Fork v1 roadmap — pi-mem-wiki

Origin: 3-seat multi-agent brainstorm (orchestrator pi/glm-5.3-flash; Claude Code;
pi/deepseek-v4.1-flash), Borda-voted, 2026-10-29. Full transcript + relay artifacts:
~/.llm-wiki/outputs/herdr-batches/llmwiki-fork/.

## v1 (this branch: fork-v1) — four evidence-located fixes
1. **Lint hardening** — lint read-only by default; bare-token wikilinks (`[[notion]]`)
   resolve as tags, never auto-created as pages; missing-page auto-creation only with an
   explicit confirm/dry-run gate and only for resolvable intra-wiki links.
   Evidence: `lib/lint.ts` autoFix creates `concepts/<name>.md` stubs when
   `mentionedBy.length < 2 && slugify(name) === name` — a bare lowercase token passes.
2. **Project scoping** — `scope: global | project:<id>` in frontmatter; ambient
   (before_agent_start) recall filters to cwd-derived project + global; personal-vault
   ambient hits suppressed unless scoped global. Evidence: `lib/task-config.ts:19,40`
   `autoRecall`/`ambientPersonalVault` are bare booleans.
3. **CJK lexical fallback + loud warning** — char-bigram term matching in the lexical
   scorer for CJK input (fixes the benchmark's guaranteed CJK miss without model
   downloads); startup warning when a semantic index is configured off but CJK content
   exists. Evidence: `docs/retrieval-benchmark.md` intentional CJK miss; `lib/recall.ts`
   lexical path has no CJK handling.
4. **Time semantics** — consume `stale_after` (declared in `lib/knowledge-document.ts:151`
   and `lib/metadata.ts:173` with no reader — upstream #314), honor page-level
   `valid_from` / `valid_until` / `superseded_by` in recall ranking and lint, and
   age-stamp recall results ("updated Nd ago"). Decay supersedes, never deletes.

## v2 (deferred, converged design)
Packet lifecycle ladder (captured→observed→promoted→archived|superseded), capture-side
quality gate, tool-owned cold-pool demotion (move-never-delete), proposal-only
consolidation agent with review queue, durable background-job journal (#303),
ingest/capture prompt-override hooks (#171), vectors opt-in behind capability probe
(local Ollama recommended).

## Explicit skips (voted)
Multi-host core/adapter split (speculative until a second host exists); claim-level
bi-temporal storage; knowledge graph.

#!/usr/bin/env node
/**
 * pi-mem-wiki fork (M1): eval a personal vault's recall quality.
 *
 * Usage: node scripts/eval-vault.mjs <vault-root> <queries.json> [--scope <projectId>]
 *   queries.json: { queries: [{ id, query, expected, ... }] } — as produced by
 *   the M0 ops pass (outputs/eval-queries.json). expected=null rows are
 *   skipped (structural CJK misses are only scoreable once vectors exist).
 *   With --layers, also runs the layered hybrid path (uses embeddings if the
 *   vault has them) and prints the lexical-vs-layered delta.
 *
 * Prints hit@5 / MRR / per-query ranks; writes nothing.
 * Personal queries stay in the vault, never in the public repo.
 */
import { existsSync, readFileSync } from "node:fs";

const rootArg = process.argv[2];
const queriesArg = process.argv[3];
const scopeIdx = process.argv.indexOf("--scope");
const projectId = scopeIdx >= 0 ? process.argv[scopeIdx + 1] : undefined;
const layers = process.argv.includes("--layers");

if (!rootArg || !queriesArg) {
  console.error("usage: node scripts/eval-vault.mjs <vault-root> <queries.json> [--scope <id>] [--layers]");
  process.exit(2);
}

// Load the fork's compiled lib (dist/) — rebuilt by `npx tsc -p tsconfig.json`.
// Plain node cannot import the repo's .ts sources directly; if dist is
// missing, point the user at the build command.
const libUrl = (rel) => new URL(`../dist/extensions/llm-wiki/lib/${rel}`, import.meta.url);
if (!existsSync(libUrl("recall.js"))) {
  console.error(
    "dist/extensions/llm-wiki/lib/recall.js not found — build first:\n  npx tsc -p tsconfig.json\n" +
      "(or run the in-repo vitest harness per docs/superpowers/roadmaps/fork-v3.md, M0-5)",
  );
  process.exit(1);
}

let searchWiki, searchWikiHybrid, resolveVaultPaths, loadTaskConfig;
({ searchWiki, searchWikiHybrid } = await import(libUrl("recall.js").href));
({ resolveVaultPaths, loadTaskConfig } = await import(libUrl("utils.js").href));

const evalSet = JSON.parse(readFileSync(queriesArg, "utf8"));
const paths = resolveVaultPaths(rootArg);

function grade(rows, label) {
  let judged = 0, hit5 = 0, reciprocal = 0, rank1 = 0;
  for (const r of rows) {
    if (!r.expected) continue;
    judged++;
    if (r.rank >= 1 && r.rank <= 5) hit5++;
    if (r.rank >= 1) {
      reciprocal += 1 / r.rank;
      if (r.rank === 1) rank1++;
    }
  }
  console.log(`${label}: judged=${judged} rank1=${rank1} hit@5=${hit5} (${(hit5 / Math.max(1, judged)).toFixed(3)}) MRR=${(reciprocal / Math.max(1, judged)).toFixed(3)}`);
  return { judged, hit5, mrr: reciprocal / Math.max(1, judged) };
}

console.log(`vault: ${paths.root}${projectId ? ` (scope: ${projectId})` : ""}`);
const lexicalRows = evalSet.queries.map((q) => {
  const results = searchWiki(paths, q.query, 5, 0, undefined, projectId ? { projectId } : undefined);
  const rank = q.expected ? results.findIndex((r) => r.id === q.expected) + 1 || 0 : 0;
  return { id: q.id, query: q.query, expected: q.expected, rank: rank || null, top1: results[0]?.id ?? null };
});
grade(lexicalRows, "LEXICAL");
for (const r of lexicalRows) console.log(`  ${r.id} rank=${String(r.rank).padEnd(4)} top1=${String(r.top1).slice(0, 60)}`);

if (layers) {
  const layeredRows = [];
  ({ loadTaskConfig } = await import(libUrl("task-config.js").href));
  const config = loadTaskConfig(rootArg) ?? {};
  // Hybrid: searchWikiHybrid resolves the embedder from config (keyless
  // loopback per fork M1); degrades to lexical when Ollama is down.
  for (const q of evalSet.queries) {
    const results = await searchWikiHybrid(paths, q.query, 5, 0, true, {
      config,
      ...(projectId ? { scopeFilter: { projectId } } : {}),
    });
    const rank = q.expected ? results.findIndex((r) => r.id === q.expected) + 1 || 0 : 0;
    layeredRows.push({ id: q.id, expected: q.expected, rank: rank || null, top1: results[0]?.id ?? null });
  }
  grade(layeredRows, "LAYERED (hybrid: embeddings + lexical)");
  for (const r of layeredRows) console.log(`  ${r.id} rank=${String(r.rank).padEnd(4)} top1=${String(r.top1 ?? "-").slice(0, 60)}`);
}
#!/usr/bin/env node
/**
 * M1 ops: chunked, resumable embeddings backfill for a whole vault.
 * Why not plain reindexEmbeddings: it writes the meta/embeddings.json store
 * only at completion — a long local run loses everything on interrupt. This
 * runner chunks the registry ids and calls embedPages per chunk, so the store
 * is written incrementally and re-runs skip fresh pages (isStale).
 */
import { existsSync } from "node:fs";
const lib = (rel) => new URL(`../dist/extensions/llm-wiki/lib/${rel}`, import.meta.url);
if (!existsSync(lib("embeddings.js"))) {
  console.error("dist missing — npx tsc -p tsconfig.json first");
  process.exit(1);
}
const root = process.argv[2];
if (!root) { console.error("usage: node scripts/backfill-embeddings.mjs <vault-root> [chunk]"); process.exit(2); }
const CHUNK = Number(process.argv[3] ?? 250);

const { resolveVaultPaths, getPersonalWikiPaths } = await import(lib("utils.js").href);
const { embedPages, readEmbeddingStore, resolveEmbedder, embeddingStorePath } = await import(lib("embeddings.js").href);
const { loadTaskConfig } = await import(lib("task-config.js").href);

const paths = resolveVaultPaths(root);
const config = loadTaskConfig(root) ?? {};
const embedder = resolveEmbedder(config);
if (!embedder) { console.error("no embedder resolved from settings"); process.exit(1); }

const registry = JSON.parse(await import("node:fs").then(m => m.readFileSync(`${paths.meta}/registry.json`, "utf8")));
const ids = Object.keys(registry.pages ?? {});
console.log(`embedder=${embedder.model} pages=${ids.length} chunk=${CHUNK}`);

const CHUNK_MS = CHUNK === Number.POSITIVE_INFINITY ? 0 : CHUNK;
let done = 0;
for (let i = 0; i < ids.length; i += CHUNK) {
  const group = ids.slice(i, i + CHUNK);
  const stats = await embedPages(paths, group, embedder, { force: false });
  done += group.length;
  const store = readEmbeddingStore(paths);
  console.log(`[${new Date().toISOString()}] chunk done: embedded=${stats.embedded} skipped=${stats.skipped} errors=${stats.errors} | store=${Object.keys(store.entries).length}/${ids.length}`);
}
const store = readEmbeddingStore(paths);
console.log(`COMPLETE store=${Object.keys(store.entries).length}/${ids.length} at ${embeddingStorePath(paths)}`);
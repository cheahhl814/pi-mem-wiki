import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseKnowledgeDocument } from "../extensions/llm-wiki/lib/knowledge-document.js";
import {
  cjkQueryDegrades,
  searchWiki,
} from "../extensions/llm-wiki/lib/recall.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { embeddingStorePath } from "../extensions/llm-wiki/lib/embeddings.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `cjk-recall-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

let paths: VaultPaths;

async function freshVault(withStore = false): Promise<VaultPaths> {
  rmSync(root, { recursive: true, force: true });
  const vault = getVaultPaths(root);
  ensureVaultStructure(vault);
  writeFileSync(
    join(vault.dotWiki, "config.json"),
    JSON.stringify({ name: "CJK recall test" }),
  );
  if (withStore) {
    writeFileSync(
      embeddingStorePath(vault),
      JSON.stringify({
        version: "1",
        entries: { "concepts/zettelkasten": { model: "test", hash: "h", vector: [1, 0] } },
      }),
      "utf8",
    );
  }
  rebuildMetadata(vault);
  return vault;
}

describe("CJK lexical recall (regression pin — upstream n-gram path works)", () => {
  it("matches a CJK query against a CJK-titled page purely lexically", async () => {
    paths = await freshVault();
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    const doc = [
      "---",
      "type: concept",
      "title: 卡片盒笔记法",
      "created: 2026-10-29",
      "updated: 2026-10-29",
      "---",
      "",
      "这是卡片盒笔记法，也称为 Zettelkasten。",
      "",
    ].join("\n");
    writeFileSync(join(paths.wiki, "concepts", "zettelkasten.md"), doc, "utf8");
    rebuildMetadata(paths);
    const results = searchWiki(paths, "什么是卡片盒笔记法", 5, 0);
    expect(results.map((r) => r.id)).toContain("concepts/zettelkasten");
    // Sanity: the doc round-trips through the parser with its CJK title intact.
    const parsed = parseKnowledgeDocument(doc, "concepts/zettelkasten.md");
    expect(parsed.ok).toBe(true);
  });
});

describe("cjkQueryDegrades (fork fix 3 loud-warning gate)", () => {
  it("true: CJK query on a vault with no embedding store", async () => {
    paths = await freshVault(false);
    expect(cjkQueryDegrades(paths, "什么是卡片盒笔记法")).toBe(true);
  });

  it("false: Latin query never degrades lexically", async () => {
    paths = await freshVault(false);
    expect(cjkQueryDegrades(paths, "what is zettelkasten")).toBe(false);
  });

  it("false: CJK query with a populated embedding store (vectors can bridge cross-script)", async () => {
    paths = await freshVault(true);
    expect(existsSync(embeddingStorePath(paths))).toBe(true);
    expect(cjkQueryDegrades(paths, "什么是卡片盒笔记法")).toBe(false);
  });
});
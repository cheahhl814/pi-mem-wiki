import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createKnowledgeDocument,
  serializeKnowledgeDocument,
} from "../extensions/llm-wiki/lib/knowledge-document.js";
import {
  classifyUnresolvedTarget,
  runWikiLint,
} from "../extensions/llm-wiki/lib/lint.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `lint-hardening-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

let paths: VaultPaths;

async function freshVault(): Promise<VaultPaths> {
  rmSync(root, { recursive: true, force: true });
  const vault = getVaultPaths(root);
  ensureVaultStructure(vault);
  // lint's assertWritableVault requires a config.json (same convention as
  // test/lint-okf.test.ts fixtures).
  writeFileSync(join(vault.dotWiki, "config.json"), JSON.stringify({ name: "Lint hardening test" }));
  rebuildMetadata(vault);
  return vault;
}

function writePage(id: string, type: string, title: string, body: string): void {
  const pagePath = join(paths.wiki ?? join(root, ".llm-wiki", "wiki"), id);
  const document = createKnowledgeDocument(
    id,
    { type, title, created: "2026-10-29", updated: "2026-10-29", status: "ingested" },
    body,
  );
  const parent = pagePath.slice(0, pagePath.lastIndexOf("/"));
  mkdirSync(parent, { recursive: true });
  writeFileSync(pagePath, serializeKnowledgeDocument(document), "utf8");
}

describe("classifyUnresolvedTarget", () => {
  it("classifies bare tokens as tags", () => {
    expect(classifyUnresolvedTarget("notion")).toBe("tag");
    expect(classifyUnresolvedTarget("logseq")).toBe("tag");
  });
  it("classifies raw packet paths as source refs", () => {
    expect(classifyUnresolvedTarget("raw/sources/SRC-2026-06-27-001/extracted")).toBe(
      "source-ref",
    );
    expect(classifyUnresolvedTarget("raw/sources/SRC-x/extracted")).toBe("source-ref");
  });
  it("classifies folder-qualified targets as pages", () => {
    expect(classifyUnresolvedTarget("concepts/missing-topic")).toBe("page");
    expect(classifyUnresolvedTarget("sources/obs-2026-10-29-deleted")).toBe("page");
  });
});

describe("lint hardening: tag-like links are informational, never stub-able", () => {
  it("does not count tag links or raw refs as missing pages and never creates concepts/<bare-token>.md", async () => {
    paths = await freshVault();
    writePage("sources/SRC-001.md", "source", "A source", "Real content.");
    writePage(
      "concepts/tagger-one.md",
      "concept",
      "Tagger one",
      "Links: [[notion]] and [[raw/sources/SRC-001/extracted]] and [[concepts/effectively-missing]].",
    );
    writePage(
      "concepts/tagger-two.md",
      "concept",
      "Tagger two",
      "More: [[notion]] and [[concepts/effectively-missing]] again.",
    );

    // Read-only lint: tag/raw refs are informational; only the concepts/-qualified
    // target counts as a missing page (counted per unresolved occurrence — here it
    // appears in two pages).
    const audit = await runWikiLint(paths, false);
    expect(audit).toContain("Missing: 2");
    expect(audit).toContain("Tag-like links (informational): 2");
    expect(audit).toContain("Source-packet links (informational): 1");
    expect(audit).not.toContain("Missing page: concepts/notion");
    expect(audit).not.toContain("[[notion]]");
    expect(audit).not.toContain("raw/sources/SRC-001/extracted");

    // Auto-fix lints: bare-token tags are never minted into pages...
    const fixed = await runWikiLint(paths, true);
    expect(existsSync(join(paths.wiki ?? join(root, ".llm-wiki", "wiki"), "concepts", "notion.md"))).toBe(false);
    expect(existsSync(join(paths.wiki ?? join(root, ".llm-wiki", "wiki"), "concepts", "raw.md"))).toBe(false);
    // ...but an explicitly folder-qualified, twice-mentioned concepts/ target still is.
    expect(existsSync(join(paths.wiki ?? join(root, ".llm-wiki", "wiki"), "concepts", "effectively-missing.md"))).toBe(true);
    expect(fixed).toContain("Missing-page fixes: 1");
    // Findings (including the missing-page list) live in the autoFix report file.
    const { readdirSync } = await import("node:fs");
    const outputs = readdirSync(paths.outputs).filter((f) => f.startsWith("lint-"));
    expect(outputs.length).toBe(1);
    const report = readFileSync(join(paths.outputs, outputs[0]), "utf8");
    expect(report).toContain("Missing page: concepts/effectively-missing");
    expect(report).not.toContain("Missing page: notion");
    const stub = readFileSync(
      join(paths.wiki ?? join(root, ".llm-wiki", "wiki"), "concepts", "effectively-missing.md"),
      "utf8",
    );
    expect(stub).toContain("status: stub");
  });

  it("single-mention concepts/ targets still need two mentions to stub", async () => {
    paths = await freshVault();
    writePage("concepts/lonelink.md", "concept", "Lone linker", "See [[concepts/lonely-target]].");
    const fixed = await runWikiLint(paths, true);
    expect(existsSync(join(paths.wiki ?? join(root, ".llm-wiki", "wiki"), "concepts", "lonely-target.md"))).toBe(false);
    expect(fixed).toContain("Missing-page fixes: 0");
  });
});
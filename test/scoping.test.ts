import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createKnowledgeDocument,
  serializeKnowledgeDocument,
} from "../extensions/llm-wiki/lib/knowledge-document.js";
import {
  searchWiki,
  searchWikiHybrid,
} from "../extensions/llm-wiki/lib/recall.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { slugify, ensureVaultStructure, getVaultPaths, type VaultPaths } from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `scoping-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

let paths: VaultPaths;

async function freshVault(): Promise<VaultPaths> {
  rmSync(root, { recursive: true, force: true });
  const vault = getVaultPaths(root);
  ensureVaultStructure(vault);
  writeFileSync(join(vault.dotWiki, "config.json"), JSON.stringify({ name: "Scoping test" }));
  rebuildMetadata(vault);
  return vault;
}

function writePage(relNoExt: string, fm: Record<string, string>, body: string): void {
  const pagePath = join(paths.wiki, `${relNoExt}.md`);
  mkdirSync(pagePath.slice(0, pagePath.lastIndexOf("/")), { recursive: true });
  const lines = ["---", `type: concept`, `title: ${fm.title}`, `created: 2026-10-29`, `updated: 2026-10-29`];
  if (fm.scope) lines.push(`scope: ${fm.scope}`);
  lines.push("---", "", body);
  writeFileSync(pagePath, `${lines.join("\n")}\n`, "utf8");
}

// This vault lives under tmp/scoping-<ts>/... inside the pi-mem-wiki repo — the
// cwd-derived project ID convention (slugified cwd basename) is exercised via
// slugify(basename(root)) here, mirroring index.ts's ambient filter.
const thisProject = slugify(basename(root));

describe("project scoping (fork fix 2)", () => {
  it("searches with scopeFilter: excludes other-project pages, keeps global + unscoped + own-project", async () => {
    paths = await freshVault();
    writePage("concepts/otherproj-only", { title: "Quantum Widgets Other Project", scope: "project:otherproject" }, "Body about quantum widgets for another repository entirely.");
    writePage("concepts/global-shared", { title: "Quantum Widgets Shared", scope: "global" }, "Body about quantum widgets shared everywhere.");
    writePage("concepts/unscoped", { title: "Quantum Widgets Unscoped" }, "Body about quantum widgets, no scope given.");
    writePage("concepts/thisproj", { title: "Quantum Widgets Own", scope: `project:${thisProject}` }, "Body about quantum widgets scoped to this repo.");
    rebuildMetadata(paths);

    const filtered = await searchWiki(paths, "quantum widgets", 10, 0, undefined, {
      projectId: thisProject,
    });
    const ids = filtered.map((r) => r.id);
    expect(ids).toContain("concepts/global-shared");
    expect(ids).toContain("concepts/unscoped");
    expect(ids).toContain("concepts/thisproj");
    expect(ids).not.toContain("concepts/otherproj-only");

    // Without a filter, all pages are candidates (default back-compat behavior).
    const unfiltered = await searchWiki(paths, "quantum widgets", 10, 0);
    expect(unfiltered.map((r) => r.id)).toContain("concepts/otherproj-only");
  });

  it("searchWikiHybrid threads the scope filter (lexical fallback path, no embedder)", async () => {
    paths = await freshVault();
    writePage("concepts/otherproj-h", { title: "Nanopore Protocol Other", scope: "project:otherproject" }, "Nanopore protocol steps for a different repository.");
    writePage("concepts/global-h", { title: "Nanopore Protocol Shared", scope: "global" }, "Nanopore protocol steps shared across repos.");
    rebuildMetadata(paths);

    const results = await searchWikiHybrid(paths, "nanopore protocol", 10, 0, false, {
      scopeFilter: { projectId: thisProject },
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain("concepts/global-h");
    expect(ids).not.toContain("concepts/otherproj-h");
  });

  it("scope is persisted on disk after writePage round-trip", async () => {
    paths = await freshVault();
    writePage("concepts/scopecheck", { title: "Scope Check", scope: "global" }, "Scope round-trip body.");
    const raw = existsSync(join(paths.wiki, "concepts", "scopecheck.md"));
    expect(raw).toBe(true);
    const text = await import("node:fs").then((m) => m.readFileSync(join(paths.wiki, "concepts", "scopecheck.md"), "utf8"));
    expect(text).toContain("scope: global");
  });
});
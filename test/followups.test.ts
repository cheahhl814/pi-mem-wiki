import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prfSeedCandidates,
  searchWiki,
} from "../extensions/llm-wiki/lib/recall.js";
import { runWikiLint } from "../extensions/llm-wiki/lib/lint.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { recallOperation } from "../mcp/operations.js";
import { loadTaskConfig } from "../extensions/llm-wiki/lib/task-config.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `followups-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

let paths: VaultPaths;

async function freshVault(): Promise<VaultPaths> {
  rmSync(root, { recursive: true, force: true });
  const vault = getVaultPaths(root);
  ensureVaultStructure(vault);
  writeFileSync(
    join(vault.dotWiki, "config.json"),
    JSON.stringify({ name: "Follow-ups test" }),
  );
  rebuildMetadata(vault);
  return vault;
}

function writePage(name: string, extraFm: Record<string, string>, body: string): void {
  const path = join(paths.wiki, "concepts", `${name}.md`);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(
    path,
    [
      "---",
      "type: concept",
      `title: ${name.replace(/-/g, " ")}`,
      "created: 2026-07-01",
      "updated: 2026-07-01",
      ...Object.entries(extraFm).map(([k, v]) => `${k}: ${v}`),
      "---",
      "",
      body,
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("lint dangling-supersession validation (review low-10)", () => {
  it("flags a superseded_by target that does not resolve; accepts a real one; counts in response", async () => {
    paths = await freshVault();
    writePage("good-target", {}, "The current protocol authority page.");
    writePage("dangling-user", { superseded_by: "concepts/does-not-exist" }, "Body of the dangling page.");
    rebuildMetadata(paths);
    // Findings live in the autoFix REPORT FILE, counts in the tool response.
    await runWikiLint(paths, true);
    const outputsDir = join(paths.outputs);
    const { readdirSync } = await import("node:fs");
    const reportFile = readdirSync(outputsDir).filter((f) => f.startsWith("lint-")).at(-1);
    const report = readFileSync(join(outputsDir, reportFile!), "utf8");
    expect(report).toContain("Dangling supersession: concepts/dangling-user → concepts/does-not-exist");
    const response = await runWikiLint(paths, false);
    expect(response).toContain("Dangling supersessions: 1");

    // Fix the target → finding disappears.
    writePage("dangling-user", { superseded_by: "concepts/good-target" }, "Body of the dangling page.");
    rebuildMetadata(paths);
    const fixed = await runWikiLint(paths, false);
    expect(fixed).not.toContain("Dangling supersessions:");
  });

  it("wikilink-form superseded_by [[concepts/x]] resolves the same as the bare id", async () => {
    paths = await freshVault();
    writePage("target-page", {}, "Target authority.");
    writePage("link-form-user", { superseded_by: "[[concepts/target-page]]" }, "Via wikilink form.");
    rebuildMetadata(paths);
    const report = await runWikiLint(paths, false);
    expect(report).not.toContain("Dangling supersession:");
  });
});

describe("PRF seed exclusion (review low-11)", () => {
  it("superseded/expired/not-yet-valid pages cannot seed expansion; stale and current can", () => {
    const pages = [
      { timeState: undefined },
      { timeState: "current" },
      { timeState: "stale" },
      { timeState: "superseded" },
      { timeState: "expired" },
      { timeState: "not-yet-valid" },
    ] as Array<{ timeState?: import("../extensions/llm-wiki/lib/recall.js").PageTimeState }>;
    const seeded = prfSeedCandidates(pages);
    expect(seeded.map((s) => s.timeState)).toEqual([undefined, "current", "stale"]);
  });
});

describe("config-declared projectId (review medium-4 better fix)", () => {
  it("llm-wiki.projectId is parsed (trimmed) from project settings", async () => {
    const projectDir = join(root, "proj-settings");
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { projectId: "  my-proj  " } }),
      "utf8",
    );
    const config = loadTaskConfig(projectDir);
    expect(config?.projectId).toBe("my-proj");
    // Unset elsewhere → undefined (automatic basename default keeps working).
    const empty = loadTaskConfig(join(root, "nowhere"));
    expect(empty?.projectId).toBeUndefined();
  });
});

describe("MCP recall knobs parity (review low-15)", () => {
  it("recallOperation threads project scoping to the layered search", async () => {
    paths = await freshVault();
    writePage("shared-knobs", { scope: "global" }, "Global page passes any project filter.");
    writePage("other-knobs", { scope: "project:other" }, "Other project page filtered out.");
    rebuildMetadata(paths);
    process.env.WIKI_HOME = root; // isolate the layered personal layer to the fixture

    const scoped = await recallOperation(paths, "knobs body", 10, { projectId: "this-project" });
    const ids = scoped.results.map((r) => r.id);
    expect(ids).toContain("concepts/shared-knobs");
    expect(ids).not.toContain("concepts/other-knobs");
    delete process.env.WIKI_HOME;
  });

  it("includeCold is the escape hatch over cold-pool decay (isolated vault, exact ×10)", async () => {
    paths = await freshVault();
    // Single page → identical base scores across both calls (no expansion noise).
    writePage("lone-cold", { lifecycle: "cold" }, "Cold page for the escape hatch check.");
    rebuildMetadata(paths);
    process.env.WIKI_HOME = root;

    const scoped = await recallOperation(paths, "escape hatch check", 10, { projectId: "this-project" });
    const escaped = await recallOperation(paths, "escape hatch check", 10, { includeCold: true });
    const coldScoped = scoped.results.find((r) => r.id === "concepts/lone-cold");
    const coldEscaped = escaped.results.find((r) => r.id === "concepts/lone-cold");
    expect(coldScoped).toBeDefined();
    expect(coldEscaped).toBeDefined();
    expect(coldEscaped!.score).toBeCloseTo(coldScoped!.score * 10, 6);
    delete process.env.WIKI_HOME;
  });
});
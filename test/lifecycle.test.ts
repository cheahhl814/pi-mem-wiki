import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseKnowledgeDocument } from "../extensions/llm-wiki/lib/knowledge-document.js";
import { searchWiki } from "../extensions/llm-wiki/lib/recall.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `lifecycle-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

let paths: VaultPaths;

async function freshVault(): Promise<VaultPaths> {
  rmSync(root, { recursive: true, force: true });
  const vault = getVaultPaths(root);
  ensureVaultStructure(vault);
  writeFileSync(
    join(vault.dotWiki, "config.json"),
    JSON.stringify({ name: "Lifecycle test" }),
  );
  rebuildMetadata(vault);
  return vault;
}

function writePage(name: string, lifecycle: string | undefined, body: string): void {
  const pagePath = join(paths.wiki, "concepts", `${name}.md`);
  mkdirSync(pagePath.slice(0, pagePath.lastIndexOf("/")), { recursive: true });
  const lines = [
    "---",
    "type: concept",
    `title: ${name.replace(/-/g, " ")}`,
    "created: 2026-10-01",
    "updated: 2026-10-01",
  ];
  if (lifecycle) lines.push(`lifecycle: ${lifecycle}`);
  lines.push("---", "", body, "");
  writeFileSync(pagePath, lines.join("\n"), "utf8");
}

describe("lifecycle ladder (fork v2-a)", () => {
  it("lifecycle parses as a standard frontmatter field (not stripped to extensions)", () => {
    const parsed = parseKnowledgeDocument(
      "---\ntype: concept\nlifecycle: cold\ntitle: t\n---\n\nbody",
      "concepts/x.md",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.frontmatter.lifecycle).toBe("cold");
    expect(parsed.document.extensions.lifecycle).toBeUndefined();
  });

  it("archived/cold pages decay x0.1 by default; includeCold is the escape hatch", async () => {
    paths = await freshVault();
    // Two identical twins: same title/body → identical base scores.
    writePage("widget-live", undefined, "Flux gauge widget calibration via standard loop.");
    writePage("widget-cold", "cold", "Flux gauge widget calibration via standard loop.");
    writePage("widget-archived", "archived", "Flux gauge widget calibration via standard loop.");
    rebuildMetadata(paths);

    const deflt = await searchWiki(paths, "flux gauge widget", 10, 0);
    const live = deflt.find((r) => r.id === "concepts/widget-live");
    const cold = deflt.find((r) => r.id === "concepts/widget-cold");
    const archived = deflt.find((r) => r.id === "concepts/widget-archived");
    expect(live).toBeDefined();
    expect(cold).toBeDefined();
    expect(archived).toBeDefined();
    expect(cold!.score).toBeCloseTo(live!.score * 0.1, 6);
    expect(archived!.score).toBeCloseTo(live!.score * 0.1, 6);

    // Escape hatch: equal base scores restored.
    const escaped = await searchWiki(paths, "flux gauge widget", 10, 0, undefined, {
      includeCold: true,
    });
    const coldEscaped = escaped.find((r) => r.id === "concepts/widget-cold");
    expect(coldEscaped!.score).toBeCloseTo(live!.score, 6);
  });

  it("promoted/observed/captured lifecycle states carry no penalty", async () => {
    paths = await freshVault();
    writePage("one", "captured", "Widget widget calibration body text.");
    writePage("two", "observed", "Widget widget calibration body text.");
    writePage("three", "promoted", "Widget widget calibration body text.");
    rebuildMetadata(paths);
    const results = await searchWiki(paths, "widget calibration", 10, 0);
    const scores = results.map((r) => r.score);
    expect(new Set(scores.map((s) => Math.round(s * 1000))).size).toBe(1);
  });
});
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { runWikiLint } from "../extensions/llm-wiki/lib/lint.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { registerWikiRecall, searchWiki } from "../extensions/llm-wiki/lib/recall.js";
import { parseClaims, writeSessionPage } from "../extensions/llm-wiki/lib/session-pages.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function freshVault(): VaultPaths {
  const root = join(import.meta.dirname, "..", "tmp", `sessrec-${Date.now()}-${Math.random()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Session recall" }));
  return paths;
}

function writeDigest(paths: VaultPaths, body: string): void {
  mkdirSync(join(paths.wiki, "digests"), { recursive: true });
  writeFileSync(
    join(paths.wiki, "digests", "w.md"),
    `---\ntype: digest\ntitle: w digest\nworkspace: w\nlifecycle: active\n---\n\n${body}\n`,
  );
}

function seed(paths: VaultPaths) {
  const page = writeSessionPage(paths, {
    workspace: "w",
    sessionId: "s1",
    claims: parseClaims("## decision: zorblax calibration uses the slow loop\nzorblax detail"),
  });
  writeDigest(paths, "## Decisions\n\n- 2026-11-14: zorblax calibration uses the slow loop");
  rebuildMetadata(paths);
  return page;
}

describe("raw session pages vs recall", () => {
  it("excludes raw session pages by default; include_raw restores them; digest ranks normally", () => {
    const paths = freshVault();
    const page = seed(paths);
    const deflt = searchWiki(paths, "zorblax calibration", 10, 0).map((r) => r.id);
    expect(deflt).toContain("digests/w");
    expect(deflt).not.toContain(page.id);
    // Ambient-style call (projectId scope, minScore 5) also never sees raw pages.
    const ambient = searchWiki(paths, "zorblax calibration", 3, 5, undefined, { projectId: "w" });
    expect(ambient.map((r) => r.id)).not.toContain(page.id);
    const raw = searchWiki(paths, "zorblax calibration", 10, 0, undefined, { includeRaw: true });
    expect(raw.map((r) => r.id)).toContain(page.id);
  });

  it("a non-session folder with type: session is unaffected", () => {
    const paths = freshVault();
    writeFileSync(
      join(paths.wiki, "concepts", "custom.md"),
      "---\ntype: session\ntitle: quuxly custom session type\n---\n\nquuxly body\n",
    );
    rebuildMetadata(paths);
    expect(searchWiki(paths, "quuxly", 10, 0).map((r) => r.id)).toContain("concepts/custom");
  });

  it("wiki_recall exposes include_raw only when session pages are on", () => {
    const schemaFor = (on: boolean) => {
      let params: { properties: Record<string, unknown> } | undefined;
      const pi = {
        registerTool: (t: { parameters: { properties: Record<string, unknown> } }) => {
          params = t.parameters;
        },
      } as unknown as ExtensionAPI;
      registerWikiRecall(pi, undefined, { includeRawParam: on });
      return params!;
    };
    expect(Object.keys(schemaFor(false).properties)).toEqual([
      "query",
      "max_results",
      "include_cold",
    ]);
    expect(schemaFor(true).properties.include_raw).toBeDefined();
  });
});

describe("session-memory lint rule", () => {
  it("flags a modified raw page and an over-cap digest; raw pages are never orphans", async () => {
    const paths = freshVault();
    const page = seed(paths);
    let report = await runWikiLint(paths, false);
    expect(report).not.toContain("Session/digest issues");

    writeFileSync(
      page.pagePath,
      readFileSync(page.pagePath, "utf8").replace("zorblax detail", "tampered"),
    );
    writeDigest(paths, Array.from({ length: 250 }, (_, i) => `- 2026-11-14: line ${i}`).join("\n"));
    rebuildMetadata(paths);
    // Lint report text is only returned in summary form; findings land in the
    // autoFix report, so run with autoFix to read them.
    report = await runWikiLint(paths, true);
    expect(report).toContain("Session/digest issues: 2");
    const out = readFileSync(
      join(paths.outputs, `lint-${new Date().toISOString().slice(0, 10)}.md`),
      "utf8",
    );
    expect(out).toContain(`Session page modified after close: ${page.id}`);
    expect(out).toContain("Digest over cap: digests/w");
    expect(out).not.toContain(`Orphan: ${page.id}`);
  });
});

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveObservation } from "../extensions/llm-wiki/lib/observation.js";
import { parseKnowledgeDocument } from "../extensions/llm-wiki/lib/knowledge-document.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `capture-gate-${Date.now()}`);

function freshVault(): VaultPaths {
  rmSync(root, { recursive: true, force: true });
  const vault = getVaultPaths(root);
  ensureVaultStructure(vault);
  writeFileSync(
    join(vault.dotWiki, "config.json"),
    JSON.stringify({ name: "Capture gate test" }),
  );
  return vault;
}

describe("capture-side gate (fork v2-c)", () => {
  it("saveObservation stamps lifecycle: captured so consolidation has a root state", async () => {
    const paths = freshVault();
    const result = saveObservation(paths, {
      title: "Gate stamping works",
      content: "A captured observation must carry lifecycle: captured for the cold pool.",
      relevance: "medium",
      tags: "fork lifecycle",
    });
    const doc = parseKnowledgeDocument(
      readFileSync(result.pagePath, "utf8"),
      `sources/${result.slug}.md`,
    );
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    expect(doc.document.frontmatter.lifecycle).toBe("captured");
    // relevance stays an extension field (fork didn't promote it to standard).
    expect(doc.document.extensions.relevance ?? doc.document.frontmatter.relevance).toBe(
      "medium",
    );
    // Body still carries the saveObservation header.
    expect(doc.document.body).toContain("Observation: Gate stamping works");
  });
});
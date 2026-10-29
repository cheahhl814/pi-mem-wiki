import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeIngestSystemPrompt, INGEST_SYSTEM } from "../extensions/llm-wiki/lib/ingest-worker.js";
import { isKnownPromptOverride, readPromptOverride } from "../extensions/llm-wiki/lib/prompts.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `prompt-hooks-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

function freshVault(): VaultPaths {
  rmSync(root, { recursive: true, force: true });
  const vault = getVaultPaths(root);
  ensureVaultStructure(vault);
  writeFileSync(
    join(vault.dotWiki, "config.json"),
    JSON.stringify({ name: "Prompt hooks test" }),
  );
  return vault;
}

describe("prompt-override hooks (fork v2-d, upstream #171)", () => {
  it("allowlist blocks arbitrary names before any file access (traversal guard)", () => {
    const paths = freshVault();
    expect(isKnownPromptOverride("ingest-synthesis")).toBe(true);
    expect(isKnownPromptOverride("../../etc/passwd")).toBe(false);
    expect(readPromptOverride(paths, "../../etc/passwd")).toBe(null);
    expect(readPromptOverride(paths, "nonexistent")).toBe(null);
  });

  it("absent override file = upstream system prompt, byte-for-byte (with language directive)", () => {
    const paths = freshVault();
    const noLang = composeIngestSystemPrompt(paths, undefined);
    expect(noLang).toBe(INGEST_SYSTEM);

    const withLang = composeIngestSystemPrompt(paths, "English");
    expect(withLang).toBe(
      INGEST_SYSTEM +
        "\n\nWrite all generated content in English, including titles, headings, summaries, descriptions, and concept/entity names. Only preserve code, API names, file paths, commands, exact technical identifiers, and verbatim quotations in their original form.",
    );
  });

  it("present override file appends a directive block after the language directive", () => {
    const paths = freshVault();
    const dir = join(paths.dotWiki, "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ingest-synthesis.md"),
      "  Always cite the source ID in every entity page.  \n",
      "utf8",
    );
    const composed = composeIngestSystemPrompt(paths, "English");
    expect(composed.startsWith(INGEST_SYSTEM)).toBe(true);
    expect(composed).toContain("## Vault-owner directive");
    expect(composed).toContain("Always cite the source ID in every entity page.");
    // Order: language directive comes before the owner block.
    expect(composed.indexOf("Write all generated content in English")).toBeLessThan(
      composed.indexOf("## Vault-owner directive"),
    );
    // Empty file = no block.
    writeFileSync(join(dir, "ingest-synthesis.md"), "   \n", "utf8");
    expect(composeIngestSystemPrompt(paths, undefined)).toBe(INGEST_SYSTEM);
    // Reader returns the trimmed content directly.
    writeFileSync(join(dir, "ingest-synthesis.md"), "Keep hub pages under 40 links.", "utf8");
    expect(readPromptOverride(paths, "ingest-synthesis")).toBe(
      "Keep hub pages under 40 links.",
    );
  });
});
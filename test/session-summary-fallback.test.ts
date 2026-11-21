import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseKnowledgeDocument } from "../extensions/llm-wiki/lib/knowledge-document.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { captureSession, redactSecrets } from "../extensions/llm-wiki/lib/session-pages.js";
import { lastAssistantText } from "../extensions/llm-wiki/lib/subagent.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

/**
 * Regression tests for the 2026-11-21 dogfood findings:
 *  1. the model summarizer silently degraded to the deterministic fallback
 *     because the model never called the `submit` tool (no prose channel),
 *  2. the secret scrubber redacted long kebab-case filenames.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function freshVault(): VaultPaths {
  const root = join(import.meta.dirname, "..", "tmp", `sess-sum-${Date.now()}-${Math.random()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Summary test" }));
  rebuildMetadata(paths);
  return paths;
}

const BRANCH = [
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "Move the billing service to GitHub Actions" }],
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Cutover done on 2026-11-18; cron jobs remain." }],
    },
  },
];

describe("secret scrubber", () => {
  it("keeps long kebab-case filenames intact", () => {
    const path =
      "/home/cheahhl814/.llm-wiki/wiki/sources/obs-2026-11-21-billing-service-ci-on-github-actions-since-2026-11-18.md";
    expect(redactSecrets(path)).toBe(path);
  });

  it("still redacts a mixed-case high-entropy blob", () => {
    const secret = "aB3xQ9zT1mK7pL2wR8yV4nC6dE0fG5hJ";
    expect(redactSecrets(`token ${secret}`)).not.toContain(secret);
  });

  it("still redacts an OpenAI-style key", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz012345";
    expect(redactSecrets(`key ${key}`)).not.toContain(key);
  });
});

describe("captureSession model channel", () => {
  it("uses parsed claims when the model answers in the claim grammar", async () => {
    const paths = freshVault();
    const res = await captureSession({
      paths,
      workspace: "w",
      sessionId: "s1",
      branch: BRANCH,
      budgetMs: 1000,
      complete: async () =>
        "## decision: move billing CI to GitHub Actions\n\nCut over 2026-11-18.",
    });
    expect(res).not.toBeNull();
    if (!res) return;
    const parsed = parseKnowledgeDocument(readFileSync(res.pagePath, "utf8"), `${res.id}.md`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.extensions.summary_quality).toBe("model");
    expect(parsed.document.body).toContain("## decision: move billing CI to GitHub Actions");
  });

  it("salvages model prose that ignores the claim grammar instead of dropping it", async () => {
    const paths = freshVault();
    const res = await captureSession({
      paths,
      workspace: "w",
      sessionId: "s2",
      branch: BRANCH,
      budgetMs: 1000,
      complete: async () => "The team decided to cut over on 2026-11-18.",
    });
    expect(res).not.toBeNull();
    if (!res) return;
    const parsed = parseKnowledgeDocument(readFileSync(res.pagePath, "utf8"), `${res.id}.md`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.extensions.summary_quality).toBe("model");
    expect(parsed.document.body).toContain("cut over on 2026-11-18");
  });

  it("falls back to the deterministic summary when the model fails outright", async () => {
    const paths = freshVault();
    const res = await captureSession({
      paths,
      workspace: "w",
      sessionId: "s3",
      branch: BRANCH,
      budgetMs: 1000,
      complete: async () => {
        throw new Error("model did not submit a result");
      },
    });
    expect(res).not.toBeNull();
    if (!res) return;
    const parsed = parseKnowledgeDocument(readFileSync(res.pagePath, "utf8"), `${res.id}.md`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.extensions.summary_quality).toBe("fallback");
    expect(parsed.document.body).toContain("fallback summary");
  });
});

describe("lastAssistantText", () => {
  it("returns the last assistant text", () => {
    const text = lastAssistantText([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "the answer" },
        ],
      },
    ]);
    expect(text).toBe("the answer");
  });

  it("returns undefined when the model produced no text", () => {
    expect(
      lastAssistantText([{ role: "assistant", content: [{ type: "toolCall" }] }]),
    ).toBeUndefined();
    expect(lastAssistantText(undefined)).toBeUndefined();
  });
});

describe("makeComplete prose channel", () => {
  it("returns the model prose when the submit tool is never called", async () => {
    vi.resetModules();
    vi.doMock("../extensions/llm-wiki/lib/subagent.js", () => ({
      runSubAgent: vi.fn(async () => "prose answer without the submit tool"),
      raceWithTimeout: vi.fn(async (p: Promise<unknown>) => p),
    }));
    const { makeComplete } = await import("../extensions/llm-wiki/lib/session-digest.js");
    const runtime = {
      resolveModel: async () => ({ ok: true, model: { name: "m" }, apiKey: "k" }),
    } as never;
    const ctx = {} as never;
    const complete = makeComplete(runtime, ctx);
    const out = await complete("sys", "user");
    expect(out).toBe("prose answer without the submit tool");
    vi.doUnmock("../extensions/llm-wiki/lib/subagent.js");
    vi.resetModules();
  });
});

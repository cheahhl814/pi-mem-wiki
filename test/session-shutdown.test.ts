import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../extensions/llm-wiki/index.js";
import { parseKnowledgeDocument } from "../extensions/llm-wiki/lib/knowledge-document.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import {
  captureSession,
  fallbackClaims,
  redactSecrets,
} from "../extensions/llm-wiki/lib/session-pages.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const roots: string[] = [];
const originalCwd = process.cwd();
afterEach(() => {
  process.chdir(originalCwd);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function freshVault(flag?: boolean): VaultPaths {
  const root = join(import.meta.dirname, "..", "tmp", `sessexit-${Date.now()}-${Math.random()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Exit test" }));
  rebuildMetadata(paths);
  if (flag !== undefined) {
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { sessionPages: { enabled: flag } } }),
    );
  }
  return paths;
}

const BRANCH = [
  { type: "message", message: { role: "user", content: "Please fix the flaky lock test\nmore" } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Done." },
        { type: "toolCall", arguments: { path: "src/lock.ts", command: "ls" } },
      ],
    },
  },
];

function pageOf(file: string) {
  const parsed = parseKnowledgeDocument(readFileSync(file, "utf8"), "x.md");
  if (!parsed.ok) throw new Error("parse");
  return parsed.document;
}

const base = (paths: VaultPaths) => ({
  paths,
  workspace: "w",
  sessionId: "sid",
  branch: BRANCH,
  budgetMs: 1000,
});

describe("deterministic fallback summarizer", () => {
  it("records user requests and touched files in claim grammar", () => {
    const claims = fallbackClaims(BRANCH);
    expect(claims.map((c) => c.kind)).toEqual(["note", "note"]);
    expect(claims[0].body).toBe("- Please fix the flaky lock test");
    expect(claims[1].body).toContain("src/lock.ts");
  });

  it("an empty session records nothing", async () => {
    const paths = freshVault();
    expect(await captureSession({ ...base(paths), branch: [] })).toBeNull();
    expect(existsSync(join(paths.wiki, "sessions"))).toBe(false);
  });
});

describe("captureSession", () => {
  it("uses the model's typed claims when they parse", async () => {
    const paths = freshVault();
    const r = await captureSession({
      ...base(paths),
      complete: async () => "## decision: lock test uses fake timers\nflake gone",
    });
    const doc = pageOf(r!.pagePath);
    expect(doc.extensions.summary_quality).toBe("model");
    expect(doc.body).toContain("## decision: lock test uses fake timers");
  });

  for (const [name, complete] of [
    ["throws", async () => Promise.reject(new Error("down"))],
    ["ignores the grammar", async () => "Here is a summary of the session."],
    ["exceeds the budget", () => new Promise<string>(() => {})],
  ] as const) {
    it(`falls back when the model ${name}`, async () => {
      const paths = freshVault();
      const r = await captureSession({ ...base(paths), complete, budgetMs: 50 });
      const doc = pageOf(r!.pagePath);
      expect(doc.extensions.summary_quality).toBe("fallback");
      expect(doc.body).toContain("fallback summary");
    });
  }
});

function harness() {
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => Promise<unknown>>>();
  const pi = {
    on: (name: string, h: (e: unknown, c: unknown) => Promise<unknown>) =>
      handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerTool: () => {},
    registerCommand: () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  extension(pi);
  return async (reason: string, cwd: string) => {
    const ctx = {
      cwd,
      hasUI: false,
      model: undefined,
      sessionManager: {
        getSessionId: () => "exit-session-1",
        getHeader: () => ({ timestamp: "2026-11-14T00:00:00.000Z" }),
        getBranch: () => BRANCH,
      },
    };
    for (const h of handlers.get("session_shutdown") ?? []) await h({ reason }, ctx);
  };
}

const sessionFiles = (p: VaultPaths) => {
  const dir = join(p.wiki, "sessions");
  return existsSync(dir)
    ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".md"))
    : [];
};

describe("session_shutdown hook", () => {
  it("flag off (default): shutdown creates no session pages anywhere", async () => {
    const paths = freshVault();
    process.chdir(paths.root);
    await harness()("quit", paths.root);
    expect(sessionFiles(paths)).toEqual([]);
  });

  it("flag on: quit freezes a fallback page (no model); reload writes nothing", async () => {
    const paths = freshVault(true);
    process.chdir(paths.root);
    const shutdown = harness();
    await shutdown("reload", paths.root);
    expect(sessionFiles(paths)).toEqual([]);
    await shutdown("quit", paths.root);
    const files = sessionFiles(paths);
    expect(files).toHaveLength(1);
    expect(String(files[0])).toMatch(/2026-11-14-exit-ses\.md$/);
  });

  it("flag toggled off after load: the hook re-reads it and writes nothing", async () => {
    const paths = freshVault(true);
    process.chdir(paths.root);
    const shutdown = harness();
    writeFileSync(
      join(paths.root, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { sessionPages: { enabled: false } } }),
    );
    await shutdown("quit", paths.root);
    expect(sessionFiles(paths)).toEqual([]);
  });
});

describe("secret redaction before freeze", () => {
  it("scrubs common token shapes but keeps ordinary prose and paths", () => {
    const out = redactSecrets(
      "use sk-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwxyz12 with AKIAABCDEFGHIJKLMNOP; password: hunter2hunter2 in src/lock.ts",
    );
    expect(out).not.toMatch(/sk-abc|ghp_abc|AKIAABC|hunter2/);
    expect(out).toContain("password: [REDACTED]");
    expect(out).toContain("src/lock.ts");
  });

  it("a fallback page never contains a pasted key", async () => {
    const paths = freshVault();
    const r = await captureSession({
      ...base(paths),
      branch: [
        {
          type: "message",
          message: { role: "user", content: "my key is sk-live0123456789abcdefXYZ" },
        },
      ],
    });
    expect(readFileSync(r!.pagePath, "utf8")).not.toContain("sk-live0123456789");
  });
});

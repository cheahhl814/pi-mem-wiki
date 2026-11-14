import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../extensions/llm-wiki/index.js";
import { parseKnowledgeDocument } from "../extensions/llm-wiki/lib/knowledge-document.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import {
  parseClaims,
  sessionBodyHash,
  workspaceSlug,
  writeSessionPage,
} from "../extensions/llm-wiki/lib/session-pages.js";
import { sessionPagesEnabled } from "../extensions/llm-wiki/lib/task-config.js";
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

function freshVault(): VaultPaths {
  const root = join(import.meta.dirname, "..", "tmp", `sess-${Date.now()}-${Math.random()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Session test" }));
  rebuildMetadata(paths);
  return paths;
}

const SAMPLE = [
  "Preamble the model should not have written.",
  "## decision: use hard-link publish",
  "Because rename clobbers.",
  "## fact: 22 pages cold-applied",
  "## bogus: unknown kind is dropped",
  "dropped body",
  "## open: does the gate count rounds?",
  "```",
  "## note: inside a fence is body, not a claim",
  "```",
  "# Some H1",
  "noise after a foreign heading",
].join("\n");

describe("session claim grammar", () => {
  it("keeps only typed sections and drops noise", () => {
    const claims = parseClaims(SAMPLE);
    expect(claims.map((c) => `${c.kind}:${c.heading}`)).toEqual([
      "decision:use hard-link publish",
      "fact:22 pages cold-applied",
      "open:does the gate count rounds?",
    ]);
    expect(claims[0].body).toBe("Because rename clobbers.");
    expect(claims[2].body).toContain("inside a fence");
    expect(claims[2].body).not.toContain("noise after");
  });
});

describe("writeSessionPage", () => {
  it("writes a frozen raw page with a verifiable body hash", () => {
    const paths = freshVault();
    const res = writeSessionPage(paths, {
      workspace: "My Proj",
      sessionId: "abcdef123456",
      claims: parseClaims(SAMPLE),
      created: "2026-11-14T01:00:00.000Z",
      closed: "2026-11-14T02:00:00.000Z",
    });
    expect(res.id).toBe("sessions/my-proj/2026-11-14-abcdef12");
    const parsed = parseKnowledgeDocument(readFileSync(res.pagePath, "utf8"), `${res.id}.md`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fm = parsed.document.frontmatter;
    expect(fm.type).toBe("session");
    expect(fm.lifecycle).toBe("raw");
    expect(fm.scope).toBe("project:my-proj");
    expect(parsed.document.extensions.closed).toBe("2026-11-14T02:00:00.000Z");
    expect(parsed.document.extensions.body_sha256).toBe(sessionBodyHash(parsed.document.body));
    const events = readFileSync(join(paths.meta, "events.jsonl"), "utf8");
    expect(events).toContain('"kind":"session-page"');
    // The page parses into the registry without blocking diagnostics.
    expect(rebuildMetadata(paths).ok).toBe(true);
  });

  it("never clobbers: a second write for the same session gets a suffix", () => {
    const paths = freshVault();
    const input = {
      workspace: "w",
      sessionId: "same",
      claims: parseClaims("## fact: one"),
      created: "2026-11-14T01:00:00.000Z",
    };
    const first = writeSessionPage(paths, input);
    const before = readFileSync(first.pagePath, "utf8");
    const second = writeSessionPage(paths, { ...input, claims: parseClaims("## fact: two") });
    expect(second.id).toBe(`${first.id}-2`);
    expect(readFileSync(first.pagePath, "utf8")).toBe(before);
  });

  it("refuses an empty claim list", () => {
    expect(() =>
      writeSessionPage(freshVault(), { workspace: "w", sessionId: "s", claims: [] }),
    ).toThrow();
  });

  it("slugifies projectId before using it as a path segment", () => {
    const paths = freshVault();
    expect(workspaceSlug(paths, { projectId: "../../etc" })).not.toContain("/");
    expect(workspaceSlug(paths, { projectId: "../../etc" })).not.toContain("..");
  });
});

function harness() {
  const tools = new Map<string, unknown>();
  const handlers = new Map<string, number>();
  const pi = {
    on: (name: string) => handlers.set(name, (handlers.get(name) ?? 0) + 1),
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  extension(pi);
  return { tools, handlers };
}

describe("sessionPages flag", () => {
  it("defaults off", () => {
    expect(sessionPagesEnabled(undefined)).toBe(false);
    expect(sessionPagesEnabled({ sessionPages: {} })).toBe(false);
    expect(sessionPagesEnabled({ sessionPages: { enabled: true } })).toBe(true);
  });

  it("flag off registers no session tools and no extra hooks", () => {
    const dir = join(import.meta.dirname, "..", "tmp", `sess-flag-${Date.now()}-${Math.random()}`);
    roots.push(dir);
    mkdirSync(dir, { recursive: true });
    process.chdir(dir);
    const off = harness();
    expect(off.tools.has("wiki_session_capture")).toBe(false);
    expect(off.tools.has("wiki_digest")).toBe(false);

    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { sessionPages: { enabled: true } } }),
    );
    const on = harness();
    expect(on.tools.has("wiki_session_capture")).toBe(true);
    // Flag on may only ADD; flag off must match the pre-feature hook set.
    for (const [name, n] of off.handlers) expect(on.handlers.get(name)).toBeGreaterThanOrEqual(n);
  });
});

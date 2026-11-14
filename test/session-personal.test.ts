import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../extensions/llm-wiki/index.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { searchWiki } from "../extensions/llm-wiki/lib/recall.js";
import {
  ambientScopeId,
  parseClaims,
  repoSlug,
  resolveSessionTarget,
  writeSessionPage,
} from "../extensions/llm-wiki/lib/session-pages.js";
import {
  loadTaskConfig,
  sessionPersonalFallbackEnabled,
  type TaskConfig,
} from "../extensions/llm-wiki/lib/task-config.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

// Everything lives under the OS temp dir: inside this repo, repoSlug would
// (correctly) find the repo's own .git and return "pi-mem-wiki".
let base: string;
let home: string;
let repo: string;
let sub: string;
const originalCwd = process.cwd();
const originalWikiHome = process.env.WIKI_HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const REPO_KEY = /^my-repo-[0-9a-f]{6}$/;

const ON: TaskConfig = { sessionPages: { enabled: true, personalFallback: true } };
const PAGES_ONLY: TaskConfig = { sessionPages: { enabled: true } };

function initVault(root: string): VaultPaths {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: basename(root) }));
  rebuildMetadata(paths);
  return paths;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sess-personal-"));
  home = join(base, "home");
  repo = join(base, "code", "My Repo");
  sub = join(repo, "src", "deep");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(sub, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env.WIKI_HOME = home;
  // Per-test user-level settings dir (personalFallback is user-level only).
  process.env.PI_CODING_AGENT_DIR = join(base, "agent");
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalWikiHome === undefined) delete process.env.WIKI_HOME;
  else process.env.WIKI_HOME = originalWikiHome;
  process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(base, { recursive: true, force: true });
});

describe("personal fallback flag", () => {
  it("is off by default and needs sessionPages.enabled too", () => {
    expect(sessionPersonalFallbackEnabled(undefined)).toBe(false);
    expect(sessionPersonalFallbackEnabled(PAGES_ONLY)).toBe(false);
    expect(sessionPersonalFallbackEnabled({ sessionPages: { personalFallback: true } })).toBe(
      false,
    );
    expect(sessionPersonalFallbackEnabled(ON)).toBe(true);
  });

  it("off: no target without a project vault, even though a personal vault exists", () => {
    initVault(home);
    expect(resolveSessionTarget(sub, PAGES_ONLY)).toBeNull();
  });
});

describe("repo slug", () => {
  it("uses the git toplevel from a subdirectory, else the cwd basename", () => {
    expect(repoSlug(sub)).toMatch(REPO_KEY);
    expect(repoSlug(sub)).toBe(repoSlug(repo));
    const loose = join(base, "Loose Dir");
    mkdirSync(loose);
    expect(repoSlug(loose)).toMatch(/^loose-dir-[0-9a-f]{6}$/);
  });

  it("two repos with the same basename get different keys", () => {
    const twin = join(base, "elsewhere", "My Repo");
    mkdirSync(join(twin, ".git"), { recursive: true });
    expect(repoSlug(twin)).toMatch(REPO_KEY);
    expect(repoSlug(twin)).not.toBe(repoSlug(repo));
  });

  it("a worktree-style .git FILE also marks the toplevel", () => {
    const wt = join(base, "wt-checkout");
    mkdirSync(join(wt, "a"), { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n");
    expect(repoSlug(join(wt, "a"))).toBe(repoSlug(wt));
    expect(repoSlug(wt)).toMatch(/^wt-checkout-[0-9a-f]{6}$/);
  });
});

describe("resolveSessionTarget", () => {
  it("on: falls back to the personal vault keyed by git toplevel, not basename(home)", () => {
    const personal = initVault(home);
    const t = resolveSessionTarget(sub, ON);
    expect(t?.paths.root).toBe(personal.root);
    expect(t?.workspace).toBe(repoSlug(sub));
    expect(t?.workspace).toMatch(REPO_KEY);
  });

  it("on: a missing personal vault is never bootstrapped", () => {
    expect(resolveSessionTarget(sub, ON)).toBeNull();
    expect(existsSync(join(home, ".llm-wiki"))).toBe(false);
  });

  it("a project vault still wins when present, with its unchanged slug", () => {
    initVault(home);
    const project = initVault(repo);
    const t = resolveSessionTarget(repo, ON);
    expect(t?.paths.root).toBe(project.root);
    expect(t?.workspace).toBe("my-repo"); // slugify(basename(project root)), as before
    expect(resolveSessionTarget(repo, PAGES_ONLY)?.paths.root).toBe(project.root);
  });
});

describe("ambient scope with the personal vault as primary", () => {
  it("flag off: byte-identical pre-feature id; on: the writer's repo slug", () => {
    const personal = initVault(home);
    expect(ambientScopeId(personal, sub, undefined)).toBe("home");
    expect(ambientScopeId(personal, sub, PAGES_ONLY)).toBe("home");
    expect(ambientScopeId(personal, sub, { projectId: "Pinned" })).toBe("Pinned");
    expect(ambientScopeId(personal, sub, ON)).toBe(repoSlug(sub));
    const project = initVault(repo);
    expect(ambientScopeId(project, repo, ON)).toBe("my-repo");
  });

  it("ambient search keeps excluding raw pages and other repos' digests", () => {
    const personal = initVault(home);
    const t = resolveSessionTarget(sub, ON)!;
    const page = writeSessionPage(t.paths, {
      workspace: t.workspace,
      sessionId: "s1",
      claims: parseClaims("## decision: frobnicator uses the quux loop"),
    });
    mkdirSync(join(personal.wiki, "digests"), { recursive: true });
    const mine = repoSlug(sub);
    for (const ws of [mine, "my-repo-000000"]) {
      writeFileSync(
        join(personal.wiki, "digests", `${ws}.md`),
        `---\ntype: digest\ntitle: frobnicator quux loop ${ws}\nscope: project:${ws}\n---\n\n## Decisions\n\n- 2026-11-14: frobnicator uses the quux loop\n`,
      );
    }
    rebuildMetadata(personal);
    const ids = searchWiki(personal, "frobnicator quux loop", 3, 5, undefined, {
      projectId: ambientScopeId(personal, sub, ON),
    }).map((r) => r.id);
    expect(ids).toContain(`digests/${mine}`);
    expect(ids).not.toContain("digests/my-repo-000000");
    expect(ids).not.toContain(page.id);
  });
});

describe("exit hook end to end", () => {
  function shutdownIn(cwd: string) {
    const handlers: Array<(e: unknown, c: unknown) => Promise<unknown>> = [];
    const pi = {
      on: (name: string, h: (e: unknown, c: unknown) => Promise<unknown>) => {
        if (name === "session_shutdown") handlers.push(h);
      },
      registerTool: () => {},
      registerCommand: () => {},
      sendMessage: () => {},
    } as unknown as ExtensionAPI;
    process.chdir(cwd);
    extension(pi);
    const ctx = {
      cwd,
      hasUI: false,
      model: undefined,
      sessionManager: {
        getSessionId: () => "personal-1",
        getHeader: () => ({ timestamp: "2026-11-14T00:00:00.000Z" }),
        getBranch: () => [
          { type: "message", message: { role: "user", content: "tidy the parser" } },
        ],
      },
    };
    return async () => {
      for (const h of handlers) await h({ reason: "quit" }, ctx);
    };
  }

  function settings(sp: Record<string, boolean>, where: "project" | "user" = "project") {
    const dir = where === "project" ? join(sub, ".pi") : join(base, "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ "llm-wiki": { sessionPages: sp } }));
  }

  const sessionsDir = (p: VaultPaths) => join(p.wiki, "sessions");

  it("fallback on: the page lands in the personal vault under the repo slug", async () => {
    const personal = initVault(home);
    settings({ personalFallback: true }, "user");
    settings({ enabled: true });
    await shutdownIn(sub)();
    expect(readdirSync(join(sessionsDir(personal), repoSlug(sub)))).toEqual([
      "2026-11-14-personal.md",
    ]);
  });

  it("a repo's own settings cannot opt the user into personal-vault writes", async () => {
    const personal = initVault(home);
    settings({ enabled: true, personalFallback: true });
    expect(loadTaskConfig(sub).sessionPages).toEqual({ enabled: true });
    await shutdownIn(sub)();
    expect(existsSync(sessionsDir(personal))).toBe(false);
  });

  it("fallback off: no page anywhere", async () => {
    const personal = initVault(home);
    settings({ enabled: true });
    await shutdownIn(sub)();
    expect(existsSync(sessionsDir(personal))).toBe(false);
  });
});

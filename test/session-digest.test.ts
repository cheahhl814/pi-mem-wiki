import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  patchKnowledgeDocument,
  readKnowledgeDocumentFile,
  writeKnowledgeDocumentFile,
} from "../extensions/llm-wiki/lib/knowledge-document.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import {
  type Complete,
  listSessionPages,
  normalizeDigest,
  runDigest,
  splitOverflow,
} from "../extensions/llm-wiki/lib/session-digest.js";
import {
  lintSessionMemoryPage,
  parseClaims,
  writeSessionPage,
} from "../extensions/llm-wiki/lib/session-pages.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const WS = "w";
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const HOUR = 3_600_000;

function freshVault(): VaultPaths {
  const root = join(import.meta.dirname, "..", "tmp", `sessdig-${Date.now()}-${Math.random()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Digest test" }));
  rebuildMetadata(paths);
  return paths;
}

function addSessions(paths: VaultPaths, n: number, startHour = 0): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const closed = new Date(T0 + (startHour + i) * HOUR).toISOString();
    ids.push(
      writeSessionPage(paths, {
        workspace: WS,
        sessionId: `s${startHour + i}`,
        claims: parseClaims(`## fact: claim number ${startHour + i}`),
        closed,
      }).id,
    );
  }
  return ids;
}

const okModel: Complete = async (_sys, user) => {
  const facts = [...user.matchAll(/## fact: (claim number \d+)/g)].map(
    (m) => `- 2026-11-01: ${m[1]}`,
  );
  return `Sure! Here it is:\n## Decisions\n\n## Facts\n${facts.join("\n")}\n## Open\n- 2026-11-01: nothing\n## Watchlist\n`;
};

const digestFile = (p: VaultPaths) => join(p.wiki, "digests", `${WS}.md`);
const lockFile = (p: VaultPaths) => join(p.meta, `digest-${WS}.lock`);
const lifecycles = (p: VaultPaths) => listSessionPages(p, WS).map((s) => s.lifecycle);
const NOW = T0 + 48 * HOUR;

describe("digest compaction gates", () => {
  it("empty vault: refused, nothing written", async () => {
    const paths = freshVault();
    const r = await runDigest(paths, WS, { complete: okModel, now: NOW });
    expect(r.code).toBe("refused");
    expect(existsSync(digestFile(paths))).toBe(false);
  });

  it("4 sessions: gate refuses, nothing written, pages stay raw", async () => {
    const paths = freshVault();
    addSessions(paths, 4);
    const r = await runDigest(paths, WS, { complete: okModel, now: NOW });
    expect(r.code).toBe("refused");
    expect(r.report).toContain("4/5");
    expect(existsSync(digestFile(paths))).toBe(false);
    expect(lifecycles(paths)).toEqual(["raw", "raw", "raw", "raw"]);
  });

  it("dry run with 6 sessions plans demotions and writes nothing", async () => {
    const paths = freshVault();
    addSessions(paths, 6);
    const r = await runDigest(paths, WS, { dryRun: true, now: NOW });
    expect(r.code).toBe("dry-run");
    expect(r.report.match(/would digest \+ set lifecycle: cold/g)).toHaveLength(6);
    expect(existsSync(digestFile(paths))).toBe(false);
    expect(lifecycles(paths).every((l) => l === "raw")).toBe(true);
  });

  it("6 sessions: builds the digest, demotes raw pages, keeps their bodies frozen", async () => {
    const paths = freshVault();
    const ids = addSessions(paths, 6);
    const r = await runDigest(paths, WS, { complete: okModel, now: NOW });
    expect(r.code).toBe("built");
    expect(r.consumed).toEqual(ids);
    const digest = readKnowledgeDocumentFile(digestFile(paths), `digests/${WS}.md`);
    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    expect(digest.document.frontmatter.type).toBe("digest");
    expect(digest.document.extensions.digested_through).toBe(new Date(T0 + 5 * HOUR).toISOString());
    expect(digest.document.extensions.raw_pages_consumed).toBe(6);
    expect(digest.document.body).toContain("- 2026-11-01: claim number 5");
    expect(digest.document.body).not.toContain("Sure!");
    expect(lifecycles(paths).every((l) => l === "cold")).toBe(true);
    // Cold demotion touched only lifecycle: the frozen body hash still verifies.
    for (const id of ids) {
      const page = readKnowledgeDocumentFile(join(paths.wiki, `${id}.md`), id);
      if (!page.ok) throw new Error("parse");
      expect(lintSessionMemoryPage(page.document)).toEqual([]);
    }
    expect(readFileSync(join(paths.meta, "events.jsonl"), "utf8")).toContain(
      '"kind":"session-digest"',
    );
    expect(existsSync(lockFile(paths))).toBe(false);
  });

  it("24h interval gate holds after a build; force bypasses it", async () => {
    const paths = freshVault();
    addSessions(paths, 6);
    await runDigest(paths, WS, { complete: okModel, now: NOW });
    addSessions(paths, 5, 100);
    expect((await runDigest(paths, WS, { complete: okModel, now: NOW + HOUR })).code).toBe(
      "refused",
    );
    const later = await runDigest(paths, WS, { complete: okModel, now: NOW + 25 * HOUR });
    expect(later.code).toBe("built");
    expect(later.consumed).toHaveLength(5);
  });
});

describe("digest compaction safety", () => {
  it("model failure writes nothing and releases the lock", async () => {
    const paths = freshVault();
    addSessions(paths, 6);
    const failing: Complete = async () => {
      throw new Error("provider down");
    };
    const r = await runDigest(paths, WS, { complete: failing, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("failed");
    expect(existsSync(digestFile(paths))).toBe(false);
    expect(lifecycles(paths).every((l) => l === "raw")).toBe(true);
    expect(existsSync(lockFile(paths))).toBe(false);
  });

  it("format-ignoring model output writes nothing", async () => {
    const paths = freshVault();
    addSessions(paths, 6);
    const r = await runDigest(paths, WS, { complete: async () => "I refuse.", now: NOW });
    expect(r.code).toBe("failed");
    expect(existsSync(digestFile(paths))).toBe(false);
  });

  it("lock contention: a concurrent build is refused; the first completes", async () => {
    const paths = freshVault();
    addSessions(paths, 6);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: Complete = async (s, u) => {
      await gate;
      return okModel(s, u);
    };
    const first = runDigest(paths, WS, { complete: slow, now: NOW });
    await new Promise((r) => setTimeout(r, 20));
    const second = await runDigest(paths, WS, { complete: okModel, now: NOW });
    expect(second.code).toBe("locked");
    release();
    expect((await first).code).toBe("built");
  });

  it("a live lock blocks; a stale (>30 min) lock is reclaimed", async () => {
    const paths = freshVault();
    addSessions(paths, 6);
    writeFileSync(lockFile(paths), "{}");
    expect((await runDigest(paths, WS, { complete: okModel, now: Date.now() })).code).toBe(
      "locked",
    );
    const old = (Date.now() - 31 * 60 * 1000) / 1000;
    utimesSync(lockFile(paths), old, old);
    expect((await runDigest(paths, WS, { complete: okModel, now: Date.now() })).code).toBe("built");
  });

  it("partial failure: digested-but-raw pages are demoted on the next run", async () => {
    const paths = freshVault();
    const ids = addSessions(paths, 6);
    await runDigest(paths, WS, { complete: okModel, now: NOW });
    // Simulate a demotion that never happened for one consumed page.
    const file = join(paths.wiki, `${ids[2]}.md`);
    const doc = readKnowledgeDocumentFile(file, ids[2]);
    if (!doc.ok) throw new Error("parse");
    writeKnowledgeDocumentFile(
      file,
      patchKnowledgeDocument(doc.document, { fields: { lifecycle: "raw" } }),
    );
    const r = await runDigest(paths, WS, { complete: okModel, now: NOW + HOUR });
    expect(r.code).toBe("demote-only");
    expect(r.demoted).toEqual([ids[2]]);
    expect(lifecycles(paths).every((l) => l === "cold")).toBe(true);
  });
});

describe("digest cap", () => {
  it("rolls the oldest settled bullets to the archive; live sections stay", () => {
    const facts = Array.from(
      { length: 300 },
      (_, i) => `- 2026-${String((i % 12) + 1).padStart(2, "0")}-01: fact ${i}`,
    );
    const sections = normalizeDigest(
      `## Facts\n${facts.join("\n")}\n## Open\n- 2025-01-01: still open`,
    );
    const { body, archived } = splitOverflow(sections);
    expect(body.split("\n").length).toBeLessThanOrEqual(200);
    expect(body).toContain("still open");
    expect(archived.length).toBeGreaterThan(0);
    expect(archived[0]).toMatch(/^- 2026-01-01/);
  });
});

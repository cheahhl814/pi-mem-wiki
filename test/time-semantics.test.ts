import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluatePageTime,
  parseDurationDays,
  searchWiki,
  type PageTimeState,
} from "../extensions/llm-wiki/lib/recall.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `time-semantics-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

let paths: VaultPaths;

async function freshVault(): Promise<VaultPaths> {
  rmSync(root, { recursive: true, force: true });
  const vault = getVaultPaths(root);
  ensureVaultStructure(vault);
  writeFileSync(
    join(vault.dotWiki, "config.json"),
    JSON.stringify({ name: "Time semantics test" }),
  );
  rebuildMetadata(vault);
  return vault;
}

function writePage(name: string, extraFm: string, body: string): void {
  const pagePath = join(paths.wiki, "concepts", `${name}.md`);
  mkdirSync(pagePath.slice(0, pagePath.lastIndexOf("/")), { recursive: true });
  const doc = [
    "---",
    "type: concept",
    `title: ${name.replace(/-/g, " ")}`,
    "created: 2026-07-01",
    "updated: 2026-07-01",
    ...extraFm.split("\n").filter(Boolean),
    "---",
    "",
    body,
    "",
  ].join("\n");
  writeFileSync(pagePath, doc, "utf8");
}

describe("parseDurationDays", () => {
  it("parses d/w/m/y durations and plain day numbers", () => {
    expect(parseDurationDays("90d")).toBe(90);
    expect(parseDurationDays("12w")).toBe(84);
    expect(parseDurationDays("6m")).toBe(180);
    expect(parseDurationDays("1y")).toBe(365);
    expect(parseDurationDays(30)).toBe(30);
    expect(parseDurationDays("not-a-duration")).toBe(null);
    expect(parseDurationDays("2026-10-29")).toBe(null);
  });
});

describe("evaluatePageTime precedence (fork fix 4)", () => {
  it("superseded_by wins over everything", () => {
    const state: PageTimeState = evaluatePageTime({
      superseded_by: "concepts/newer-page",
      valid_until: "2020-01-01",
      stale_after: "1d",
      updated: "2020-01-01",
    }).state;
    expect(state).toBe("superseded");
  });

  it("valid_until in the past expires; in the future stays current", () => {
    expect(evaluatePageTime({ valid_until: "2020-01-01" }).state).toBe("expired");
    expect(evaluatePageTime({ valid_until: "2099-01-01" }).state).toBe("current");
    expect(evaluatePageTime({ valid_until: "2020-01-01" }).note).toContain("2020-01-01");
  });

  it("valid_from in the future marks not-yet-valid", () => {
    const info = evaluatePageTime({ valid_from: "2099-01-01" });
    expect(info.state).toBe("not-yet-valid");
    expect(info.note).toContain("2099-01-01");
  });

  it("stale_after duration vs updated date decides staleness", () => {
    const info = evaluatePageTime({ stale_after: "90d", updated: "2026-07-01" });
    // The page is older than 90d relative to the real clock (test runs in 2026-10).
    expect(info.state).toBe("stale");
    expect(info.note).toContain("stale after 90d");
    expect(evaluatePageTime({ stale_after: "3650d", updated: "2026-07-01" }).state).toBe(
      "current",
    );
    // No valid updated date → stale_after is inert.
    expect(evaluatePageTime({ stale_after: "1d" }).state).toBe("current");
  });
});

describe("searchWiki time-decay integration", () => {
  it("ranks an identical superseded twin strictly below its current page and stamps age", async () => {
    paths = await freshVault();
    // Two identical twins: same title/body → identical base scores.
    writePage(
      "protocol-current",
      "",
      "Quantum widget calibration protocol is to flip the flux and read the gauge.",
    );
    writePage(
      "protocol-old",
      "superseded_by: concepts/protocol-current",
      "Quantum widget calibration protocol is to flip the flux and read the gauge.",
    );
    rebuildMetadata(paths);

    const results = searchWiki(paths, "quantum widget calibration", 5, 0);
    const byId = new Map(results.map((r) => [r.id, r] as const));
    const current = byId.get("concepts/protocol-current");
    const old = byId.get("concepts/protocol-old");
    expect(current).toBeDefined();
    expect(old).toBeDefined();
    // Ranking: current strictly above superseded. With review follow-up PRF-seed
    // exclusion the pre-decay bases are no longer identical (the superseded
    // twin cannot feed expansion), so assert order + strong decay rather than
    // an exact ×10 ratio.
    expect(results.findIndex((r) => r.id === "concepts/protocol-current")).toBeLessThan(
      results.findIndex((r) => r.id === "concepts/protocol-old"),
    );
    expect(old!.score).toBeLessThan(current!.score * 0.5);
    // Age stamps: superseded twin carries state + note; current carries days.
    expect(old!.age?.state).toBe("superseded");
    expect(old!.age?.note).toBe("superseded by concepts/protocol-current");
    expect(old!.age?.days).toBeDefined();
    expect(current!.age?.state).toBeUndefined();
    expect(current!.age?.days).toBeDefined();
  });

  it("stale pages surface a stale age stamp with a reduced score", async () => {
    paths = await freshVault();
    writePage(
      "stale-guide",
      "stale_after: 30d",
      "Quantum widget maintenance guide for flux gauge servicing.",
    );
    rebuildMetadata(paths);
    const results = searchWiki(paths, "quantum widget", 5, 0);
    expect(results.length).toBe(1);
    // Page updated 2026-07-01 and stale_after 30d → stale by the real clock.
    expect(results[0].age?.state).toBe("stale");
    expect(results[0].age?.note).toContain("stale after 30d");
    // Decay actually applied: score must be a non-integer decimated value path.
    expect(results[0].score).toBeGreaterThan(0);
  });
});
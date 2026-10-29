import { existsSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConsolidate } from "../extensions/llm-wiki/lib/consolidate.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `consolidate-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

let paths: VaultPaths;

async function freshVault(): Promise<VaultPaths> {
  rmSync(root, { recursive: true, force: true });
  const vault = getVaultPaths(root);
  ensureVaultStructure(vault);
  writeFileSync(
    join(vault.dotWiki, "config.json"),
    JSON.stringify({ name: "Consolidate test" }),
  );
  rebuildMetadata(vault);
  return vault;
}

function writePacket(rel: string, fm: Record<string, string>, body: string): void {
  const pagePath = join(paths.wiki, `${rel}.md`);
  mkdirSync(pagePath.slice(0, pagePath.lastIndexOf("/")), { recursive: true });
  const lines = [
    "---",
    `type: ${fm.type ?? "source"}`,
    `title: ${fm.title ?? rel}`,
    "created: 2026-10-01",
    "updated: 2026-10-01",
    `status: ${fm.status ?? "observation"}`,
  ];
  if (fm.tags) lines.push(`tags: [${fm.tags}]`);
  if (fm.lifecycle) lines.push(`lifecycle: ${fm.lifecycle}`);
  if (fm.stale_after) lines.push(`stale_after: ${fm.stale_after}`);
  lines.push("---", "", body, "");
  writeFileSync(pagePath, lines.join("\n"), "utf8");
}

describe("wiki_consolidate — proposal-only (fork v2-b)", () => {
  it("clusters un-promoted packets by first tag, flags stale + low packets, writes ONE proposal, journals the event, and never writes wiki pages", async () => {
    paths = await freshVault();
    // Three herdr-tagged packets → one cluster; three agent-memory ones → another.
    for (let i = 1; i <= 3; i++) {
      writePacket(`sources/obs-herd-${i}`, { tags: "herdr, delegation" }, `Herdr packet ${i}.`);
    }
    for (let i = 1; i <= 3; i++) {
      writePacket(
        `sources/obs-mem-${i}`,
        { tags: "agent-memory", type: "observation" },
        `Memory packet ${i}.`,
      );
    }
    // One promoted packet must NOT count as un-promoted / cluster material.
    writePacket(
      "sources/obs-promoted",
      { tags: "agent-memory", lifecycle: "promoted" },
      "Already distilled.",
    );
    // One stale packet (stale_after passed vs updated 2026-10-01).
    writePacket(
      "sources/obs-stale",
      { tags: "misc", stale_after: "7d" },
      "This packet is long in the tooth.",
    );
    // One low-relevance un-promoted packet → cold-pool candidate without staleness.
    writePacket(
      "sources/obs-low",
      { tags: "misc", status: "observation" },
      "Low relevance packet.",
    );
    rebuildMetadata(paths);
    // relevance isn't in frontmatter here — extend the low packet directly.
    const lowPath = join(paths.wiki, "sources", "obs-low.md");
    writeFileSync(
      lowPath,
      readLow(lowPath).replace("---\n", "---\nrelevance: low\n"),
      "utf8",
    );
    rebuildMetadata(paths);

    const before = countWikiPages();
    const result = runConsolidate(paths, {});
    const after = countWikiPages();

    // Proposal-only: the wiki page set is unchanged.
    expect(after).toBe(before);
    expect(result.counts.pages).toBe(9);
    expect(result.counts.unPromoted).toBe(8); // 6 fresh + obs-stale + obs-low (obs-promoted excluded)
    expect(result.counts.stale).toBe(1);
    expect(result.counts.coldPoolCandidates).toBe(2); // obs-stale + obs-low
    // Two clusters (herdr ×3, agent-memory ×3); promoted packet filtered out.
    expect(result.counts.clusters).toBe(2);

    // The single durable artifact exists; sections present.
    expect(existsSync(result.proposalPath)).toBe(true);
    const proposal = readLow(result.proposalPath);
    expect(proposal).toContain("proposal-only");
    expect(proposal).toContain("**herdr** (3 packets)");
    expect(proposal).toContain("**agent-memory** (3 packets)");
    expect(proposal).toContain("[[sources/obs-stale]]");
    expect(proposal).toContain("[[sources/obs-low]]");
    expect(proposal).not.toContain("[[sources/obs-promoted]]");

    // Durable journal: exactly one consolidate event was appended (#303).
    const events = readLow(join(paths.meta, "events.jsonl"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const consolidateEvents = events.filter((e) => e.kind === "consolidate");
    expect(consolidateEvents.length).toBe(1);
    expect(consolidateEvents[0].proposal_path).toBe(result.proposalPath);

    // Machine-readable counts written for status surfaces.
    expect(existsSync(join(paths.discoveries, "consolidate.json"))).toBe(true);
  });
});

// ── tiny helpers ──
function readLow(p: string): string {
  return readFileSync(p, "utf8");
}
function countWikiPages(): number {
  let n = 0;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) {
        statSync(full);
        n++;
      }
    }
  };
  walk(paths.wiki);
  return n;
}
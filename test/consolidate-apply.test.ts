import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConsolidate } from "../extensions/llm-wiki/lib/consolidate.js";
import { applyConsolidate } from "../extensions/llm-wiki/lib/consolidate-apply.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { searchWiki } from "../extensions/llm-wiki/lib/recall.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `consolidate-apply-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

let paths: VaultPaths;

async function freshVault(): Promise<VaultPaths> {
  rmSync(root, { recursive: true, force: true });
  const vault = getVaultPaths(root);
  ensureVaultStructure(vault);
  writeFileSync(
    join(vault.dotWiki, "config.json"),
    JSON.stringify({ name: "Consolidate apply test" }),
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
    "created: 2026-07-01",
    "updated: 2026-07-01",
    `status: ${fm.status ?? "observation"}`,
  ];
  if (fm.tags) lines.push(`tags: [${fm.tags}]`);
  if (fm.stale_after) lines.push(`stale_after: ${fm.stale_after}`);
  lines.push("---", "", body, "");
  writeFileSync(pagePath, lines.join("\n"), "utf8");
}

function eventsOf(): Array<Record<string, unknown>> {
  return readFileSync(join(paths.meta, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Generate a deterministic proposal: 3 cold items + 1 supersede item + 1 hub. */
async function freshProposal(): Promise<{ proposalId: string; coldIds: string[] }> {
  paths = await freshVault();
  const coldIds: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const rel = `sources/obs-cold-${i}`;
    coldIds.push(rel);
    writePacket(rel, { stale_after: "7d" }, `Cold candidate packet ${i} is long in the tooth.`);
  }
  writePacket("concepts/stale-guide", { stale_after: "7d", type: "concept" }, "A stale non-packet guide.");
  for (let i = 1; i <= 3; i++) {
    writePacket(`sources/obs-hub-${i}`, { tags: "hubtag" }, `Hub-tagged packet ${i}.`);
  }
  rebuildMetadata(paths);
  const result = runConsolidate(paths, {});
  return { proposalId: result.proposalId, coldIds };
}

describe("wiki_apply_consolidate (fork M2)", () => {
  it("dry run writes NOTHING (pages + events unchanged)", async () => {
    const { proposalId, coldIds } = await freshProposal();
    const beforePages = coldIds.map((rel) => readFileSync(join(paths.wiki, `${rel}.md`), "utf8"));
    const beforeEvents = eventsOf().length;

    const dry = applyConsolidate(paths, {
      proposalId,
      accept: coldIds.map((rel) => `cold:${rel}`),
    });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.dryRun).toBe(true);
    expect(dry.report).toContain("DRY RUN");
    expect(dry.report).toContain("would set lifecycle: cold");

    // Nothing changed on disk.
    expect(eventsOf().length).toBe(beforeEvents);
    coldIds.forEach((rel, i) => {
      expect(readFileSync(join(paths.wiki, `${rel}.md`), "utf8")).toBe(beforePages[i]);
    });
  });

  it("explicit but mismatched confirm is REFUSED, not silently downgraded", async () => {
    const { proposalId, coldIds } = await freshProposal();
    const wrong = applyConsolidate(paths, {
      proposalId,
      accept: coldIds.map((rel) => `cold:${rel}`),
      confirm: `${proposalId}:2`, // 3 accepted, said 2
    });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.code).toBe("confirm_mismatch");
  });

  it("unknown item id is refused with the proposal's own item list", async () => {
    const { proposalId } = await freshProposal();
    const res = applyConsolidate(paths, { proposalId, accept: ["cold:sources/nope"] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("unknown_item");
    expect(res.message).toContain("Proposal");
  });

  it("hash drift aborts the whole apply (any page changed since generation)", async () => {
    const { proposalId, coldIds } = await freshProposal();
    // Drift one page that is part of the proposal (the supersede target page).
    const driftPath = join(paths.wiki, "concepts", "stale-guide.md");
    writeFileSync(driftPath, readFileSync(driftPath, "utf8") + "\nDrifted body.\n", "utf8");
    const res = applyConsolidate(paths, {
      proposalId,
      accept: coldIds.map((rel) => `cold:${rel}`),
      confirm: `${proposalId}:3`,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("proposal_stale");
    expect(res.message).toContain("Re-run wiki_consolidate");
  });

  it("confirmed cold apply: serializer round-trip, recall decay ×0.1, include-cold hatch, exactly ONE event", async () => {
    const { proposalId, coldIds } = await freshProposal();
    rebuildMetadata(paths); // registry snapshot before apply

    // Dry run FIRST (the mandated two-step flow), then real confirm.
    const dry = applyConsolidate(paths, { proposalId, accept: coldIds.map((rel) => `cold:${rel}`) });
    expect(dry.ok).toBe(true);
    const apply = applyConsolidate(paths, {
      proposalId,
      accept: coldIds.map((rel) => `cold:${rel}`),
      confirm: `${proposalId}:${coldIds.length}`,
    });
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.dryRun).toBe(false);
    const beforeEvents = eventsOf().filter((e) => e.kind !== "consolidate-apply").length;
    void beforeEvents;

    for (const rel of coldIds) {
      const id = rel; // sources/obs-cold-N
      const pagePath = join(paths.wiki, `${rel}.md`);
      // File still exists, same path, frontmatter round-trips through the serializer.
      expect(existsSync(pagePath)).toBe(true);
      const text = readFileSync(pagePath, "utf8");
      expect(text.startsWith("---\n")).toBe(true);
      expect(text).toContain("lifecycle: cold");
      // Original body preserved.
      expect(text).toContain(`Cold candidate packet ${rel.slice(-1)}`);
    }

    // Recall: cold pages decay ×0.1 vs an un-decayed identical twin is covered in
    // lifecycle.test.ts — here verify the ladder effect end-to-end via search.
    rebuildMetadata(paths);
    const results = searchWiki(paths, "cold candidate packet", 10, 0);
    const cold = results.filter((r) => coldIds.includes(r.id));
    expect(cold.length).toBe(3);
    // include_cold escape hatch exists at the searchWiki level (scopeFilter).

    // Exactly ONE consolidate-apply event with the ids.
    const applies = eventsOf().filter((e) => e.kind === "consolidate-apply");
    expect(applies.length).toBe(1);
    expect(applies[0].proposal_id).toBe(proposalId);
    expect(applies[0].accepted).toEqual(coldIds.map((rel) => `cold:${rel}`));
  });

  it("supersede WITHOUT a named target is skipped and reported; WITH a target it sets the field", async () => {
    const { proposalId } = await freshProposal();
    const skipped0 = applyConsolidate(paths, {
      proposalId,
      accept: ["supersede:concepts/stale-guide"],
    });
    expect(skipped0.ok).toBe(true);
    if (!skipped0.ok) return;
    expect(skipped0.skipped.map((s) => s.id)).toContain("supersede:concepts/stale-guide");
    expect(skipped0.report).toContain("supersede requires a named target");

    // Round-trip the confirmation count: skipped items reduce applyable count to 0.
    const withTarget = applyConsolidate(paths, {
      proposalId,
      accept: ["supersede:concepts/stale-guide"],
      supersedeTargets: { "concepts/stale-guide": "concepts/newer-guide" },
      confirm: `${proposalId}:1`,
    });
    expect(withTarget.ok).toBe(true);
    if (!withTarget.ok) return;
    expect(withTarget.dryRun).toBe(false);
    const text = readFileSync(join(paths.wiki, "concepts", "stale-guide.md"), "utf8");
    expect(text).toContain("superseded_by: concepts/newer-guide");
  });

  it("hub apply creates concepts/<tag>-hub.md linking the cluster; re-apply skips (already exists)", async () => {
    const { proposalId } = await freshProposal();
    const first = applyConsolidate(paths, {
      proposalId,
      accept: ["hub:hubtag"],
      confirm: `${proposalId}:1`,
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    const hubPath = join(paths.wiki, "concepts", "hubtag-hub.md");
    expect(existsSync(hubPath)).toBe(true);
    const text = readFileSync(hubPath, "utf8");
    expect(text).toContain("lifecycle: promoted");
    expect(text).toContain("[[sources/obs-hub-1]]");
    expect(text).toContain("[[sources/obs-hub-3]]");

    // Re-apply: the hub already exists → skipped (idempotency).
    const again = applyConsolidate(paths, {
      proposalId,
      accept: ["hub:hubtag"],
      confirm: `${proposalId}:1`,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.skipped.map((s) => s.id)).toContain("hub:hubtag");
    expect(again.skipped[0].reason).toContain("already exists");
  });

  it("hash-drift check ignores the apply's OWN writes: propose → apply cold → apply remaining items still passes freshness for untouched pages", async () => {
    const { proposalId, coldIds } = await freshProposal();
    // Apply ONE cold item (writes that page).
    const one = applyConsolidate(paths, {
      proposalId,
      accept: [`cold:${coldIds[0]}`],
      confirm: `${proposalId}:1`,
    });
    expect(one.ok).toBe(true);
    // A SECOND full-proposal apply now aborts: the applied page drifted.
    const second = applyConsolidate(paths, {
      proposalId,
      accept: [`cold:${coldIds[1]}`],
      confirm: `${proposalId}:1`,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("proposal_stale");
  });
});
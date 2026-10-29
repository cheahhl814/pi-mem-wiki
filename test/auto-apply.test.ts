import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConsolidate } from "../extensions/llm-wiki/lib/consolidate.js";
import {
  applyConsolidate,
  deriveAutoApplyAccept,
  AUTO_APPLY_COLD_CAP,
} from "../extensions/llm-wiki/lib/consolidate-apply.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `auto-apply-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

let paths: VaultPaths;

async function freshVault(autoApplyCold?: boolean): Promise<VaultPaths> {
  rmSync(root, { recursive: true, force: true });
  const vault = getVaultPaths(root);
  ensureVaultStructure(vault);
  writeFileSync(
    join(vault.dotWiki, "config.json"),
    JSON.stringify({ name: "Auto apply test" }),
  );
  // Project-level namespaced settings for loadTaskConfig(root).
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "settings.json"),
    JSON.stringify({ "llm-wiki": autoApplyCold === undefined ? {} : { autoApplyCold } }),
    "utf8",
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
  if (fm.stale_after) lines.push(`stale_after: ${fm.stale_after}`);
  lines.push("---", "", body, "");
  writeFileSync(pagePath, lines.join("\n"), "utf8");
}

function seedEligibleEvents(rounds = 3): void {
  const events: Array<Record<string, unknown>> = [];
  for (let r = 0; r < rounds; r++) {
    events.push({ kind: "consolidate", proposal_id: `P-seed-${r}` });
    events.push({
      kind: "consolidate-apply",
      proposal_id: `P-seed-${r}`,
      accepted: ["cold:seed/a", "cold:seed/b", "cold:seed/c"],
      rejected: [],
      skipped: [],
    });
  }
  mkdirSync(paths.meta, { recursive: true });
  writeFileSync(
    join(paths.meta, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
}

describe("deriveAutoApplyAccept (pure gate, fork M3)", () => {
  it("refuses when llm-wiki.autoApplyCold is false/absent — even with an eligible ledger", () => {
    const items = [
      { id: "cold:a", action: "cold" as const },
      { id: "supersede:b", action: "supersede" as const },
      { id: "hub:t", action: "hub" as const },
    ];
    const eligible = {
      proposals: 5, applyRounds: 5, accepts: 9, rejects: 1,
      coldAccepts: 4, coldRejects: 0, coldRounds: 4, coldRate: 1, autoApplyEligible: true,
    };
    const refused = deriveAutoApplyAccept(items, false, eligible);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toContain("autoApplyCold is false");
  });

  it("refuses under-eligible ledgers regardless of the switch", () => {
    const items = [{ id: "cold:a", action: "cold" as const }];
    const notEnoughRounds = {
      proposals: 3, applyRounds: 2, accepts: 2, rejects: 0,
      coldAccepts: 2, coldRejects: 0, coldRounds: 2, coldRate: 1, autoApplyEligible: false,
    };
    expect(deriveAutoApplyAccept(items, true, notEnoughRounds).allowed).toBe(false);
    const lowRate = {
      proposals: 4, applyRounds: 4, accepts: 8, rejects: 2,
      coldAccepts: 4, coldRejects: 1, coldRounds: 4, coldRate: 0.8, autoApplyEligible: false,
    };
    const refused = deriveAutoApplyAccept(items, true, lowRate);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toContain("80%");
  });

  it("eligible: returns COLD ids only, capped at 25", () => {
    const eligible = {
      proposals: 4, applyRounds: 4, accepts: 30, rejects: 0,
      coldAccepts: 30, coldRejects: 0, coldRounds: 4, coldRate: 1, autoApplyEligible: true,
    };
    const many: Array<{ id: string; action: "cold" | "supersede" | "hub" }> = Array.from(
      { length: 30 },
      (_, i) => ({
        id: `cold:page-${i}`,
        action: "cold" as const,
      }),
    );
    many.push({ id: "supersede:s", action: "supersede" as const }, { id: "hub:t", action: "hub" as const });
    const allowed = deriveAutoApplyAccept(many, true, eligible);
    expect(allowed.allowed).toBe(true);
    if (!allowed.allowed) return;
    expect(allowed.accept.length).toBe(AUTO_APPLY_COLD_CAP);
    expect(allowed.accept.every((id) => id.startsWith("cold:"))).toBe(true);
    expect(allowed.capped).toBe(true);
  });
});

describe("applyConsolidate auto path end-to-end (fork M3)", () => {
  it("auto: true with a non-eligible ledger → refused (auto_apply_refused), nothing written", async () => {
    paths = await freshVault(false);
    writePacket("sources/obs-auto-1", { stale_after: "7d" }, "Auto candidate one.");
    writePacket("sources/obs-auto-2", { stale_after: "7d" }, "Auto candidate two.");
    rebuildMetadata(paths);
    const proposal = runConsolidate(paths, {});
    const before = readFileSync(join(paths.wiki, "sources", "obs-auto-1.md"), "utf8");
    const res = applyConsolidate(paths, {
      proposalId: proposal.proposalId,
      accept: [],
      auto: true,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("auto_apply_refused");
    // Nothing written.
    expect(readFileSync(join(paths.wiki, "sources", "obs-auto-1.md"), "utf8")).toBe(before);
  });

  it("auto: true with autoApplyCold=true + eligible ledger applies ALL cold items (and only those)", async () => {
    paths = await freshVault(true);
    writePacket("sources/obs-auto-1", { stale_after: "7d" }, "Auto candidate one.");
    writePacket("sources/obs-auto-2", { stale_after: "7d" }, "Auto candidate two.");
    writePacket("concepts/stale-hubtest", { stale_after: "7d", type: "concept" }, "Stale guide (supersede candidate, auto skips it).");
    rebuildMetadata(paths);
    const proposal = runConsolidate(paths, {});
    seedEligibleEvents(3);

    const withAutoDry = applyConsolidate(paths, {
      proposalId: proposal.proposalId,
      accept: [],
      auto: true,
    });
    expect(withAutoDry.ok).toBe(true);
    if (!withAutoDry.ok) return;
    expect(withAutoDry.dryRun).toBe(true); // auto without confirm = dry run first
    const coldCount = withAutoDry.accepted.length;

    const withAuto = applyConsolidate(paths, {
      proposalId: proposal.proposalId,
      accept: [],
      auto: true,
      confirm: `${proposal.proposalId}:${coldCount}`,
    });
    expect(withAuto.ok, JSON.stringify(withAuto)).toBe(true);
    if (!withAuto.ok) return;
    expect(withAuto.dryRun).toBe(false);
    expect(withAuto.accepted).toEqual(["cold:sources/obs-auto-1", "cold:sources/obs-auto-2"]);
    // Cold pages got the flag via the serializer round-trip.
    for (const rel of ["sources/obs-auto-1", "sources/obs-auto-2"]) {
      expect(readFileSync(join(paths.wiki, `${rel}.md`), "utf8")).toContain("lifecycle: cold");
    }
    // Non-cold item untouched: the supersede candidate did NOT gain a field.
    const guide = readFileSync(join(paths.wiki, "concepts", "stale-hubtest.md"), "utf8");
    expect(guide).not.toContain("superseded_by");
    expect(guide).not.toContain("lifecycle: cold");

    // Manual list with auto → refused explicitly (prevents mixed-mode confusion).
    const manual = applyConsolidate(paths, {
      proposalId: proposal.proposalId,
      accept: ["supersede:concepts/stale-hubtest"],
      auto: true,
      supersedeTargets: { "concepts/stale-hubtest": "concepts/x" },
    });
    expect(manual.ok).toBe(false);
    if (manual.ok) return;
    expect(manual.code).toBe("auto_apply_refused");
    expect(manual.message).toContain("accept: []");
  });

  it("auto respects the 25-item cap on a big proposal", async () => {
    paths = await freshVault(true);
    for (let i = 1; i <= 30; i++) {
      writePacket(`sources/obs-cap-${i}`, { stale_after: "7d" }, `Cap candidate ${i}.`);
    }
    rebuildMetadata(paths);
    const proposal = runConsolidate(paths, {});
    seedEligibleEvents(3);
    const res = applyConsolidate(paths, { proposalId: proposal.proposalId, accept: [], auto: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted.length).toBe(AUTO_APPLY_COLD_CAP);
    // Remaining 5 stay undemoted for the next round (move-never-delete).
    // NB: ids sort lexicographically (cap-1, cap-10, …, cap-30, cap-4), so the
    // genuinely outside-the-cap page is cap-4.
    const leftover = readFileSync(join(paths.wiki, "sources", "obs-cap-4.md"), "utf8");
    expect(leftover).not.toContain("lifecycle: cold");
  });
});
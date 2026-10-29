import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeConsolidationLedger,
  ledgerLine,
} from "../extensions/llm-wiki/lib/consolidate-ledger.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  type VaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `ledger-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

function freshVault(): VaultPaths {
  const vault = getVaultPaths(root);
  rmSync(root, { recursive: true, force: true });
  ensureVaultStructure(vault) as void;
  writeFileSync(
    join(vault.dotWiki, "config.json"),
    JSON.stringify({ name: "Ledger test" }),
  );
  return vault;
}

function writeEvents(paths: VaultPaths, events: Array<Record<string, unknown>>): void {
  mkdirSync(paths.meta, { recursive: true });
  writeFileSync(
    join(paths.meta, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
}

describe("consolidation ledger (fork M3, measure-only)", () => {
  it("aggregates proposals, rounds, and per-action rates from events.jsonl", () => {
    const vault = freshVault();
    writeEvents(vault, [
      { kind: "consolidate", proposal_id: "P-1" },
      { kind: "consolidate", proposal_id: "P-2" },
      { kind: "consolidate-apply", proposal_id: "P-2", accepted: ["cold:a", "cold:b"], rejected: [], skipped: [] },
      { kind: "consolidate", proposal_id: "P-3" },
      { kind: "consolidate-apply", proposal_id: "P-3", accepted: ["cold:c"], rejected: ["cold:d"], skipped: [] },
      { kind: "retro", slug: "unrelated" },
    ]);
    const ledger = computeConsolidationLedger(vault);
    expect(ledger.proposals).toBe(3);
    expect(ledger.applyRounds).toBe(2);
    expect(ledger.accepts).toBe(3);
    expect(ledger.rejects).toBe(1);
    expect(ledger.coldAccepts).toBe(3);
    expect(ledger.coldRejects).toBe(1);
    expect(ledger.coldRate).toBeCloseTo(0.75, 6);
    // Gate: rate too low even though... only 2 rounds anyway.
    expect(ledger.autoApplyEligible).toBe(false);
  });

  it("gate requires rounds ≥ 3 AND cold rate ≥ 0.9", () => {
    const vault = freshVault();
    const events: Array<Record<string, unknown>> = [{ kind: "consolidate", proposal_id: "P-1" }];
    for (let r = 0; r < 3; r++) {
      events.push({
        kind: "consolidate-apply",
        proposal_id: `P-${r}`,
        accepted: ["cold:a", "cold:b", "cold:c", "cold:d", "cold:e", "cold:f", "cold:g", "cold:h", "cold:i"],
        rejected: ["cold:j"],
        skipped: [],
      });
    }
    writeEvents(vault, events);
    const ledger = computeConsolidationLedger(vault);
    expect(ledger.applyRounds).toBe(3);
    expect(ledger.coldRate).toBeCloseTo(0.9, 6);
    expect(ledger.autoApplyEligible).toBe(true);
    expect(ledgerLine(ledger)).toContain("ELIGIBLE");
  });

  it("3 rounds at 80% stay not-eligible; 2 rounds at 100% stay not-eligible", () => {
    const vault = freshVault();
    const events: Array<Record<string, unknown>> = [];
    for (let r = 0; r < 3; r++) {
      events.push({ kind: "consolidate", proposal_id: `P-${r}` });
      events.push({
        kind: "consolidate-apply",
        proposal_id: `P-${r}`,
        accepted: ["cold:a", "cold:b", "cold:c", "cold:d"],
        rejected: ["cold:e"],
        skipped: [],
      });
    }
    writeEvents(vault, events);
    expect(computeConsolidationLedger(vault).autoApplyEligible).toBe(false);

    const vault2 = freshVault();
    writeEvents(vault2, [
      { kind: "consolidate", proposal_id: "P-1" },
      { kind: "consolidate-apply", proposal_id: "P-1", accepted: ["cold:a", "cold:b"], rejected: [], skipped: [] },
      { kind: "consolidate", proposal_id: "P-2" },
      { kind: "consolidate-apply", proposal_id: "P-2", accepted: ["cold:c"], rejected: [], skipped: [] },
    ]);
    const short = computeConsolidationLedger(vault2);
    expect(short.coldRate).toBe(1);
    expect(short.autoApplyEligible).toBe(false); // rounds < 3
  });

  it("fresh vault (no events file) → zero ledger, harmless line", () => {
    const vault = freshVault();
    const ledger = computeConsolidationLedger(vault);
    expect(ledger.proposals).toBe(0);
    expect(ledger.applyRounds).toBe(0);
    expect(ledger.coldRate).toBe(null);
    expect(ledger.autoApplyEligible).toBe(false);
    expect(ledgerLine(ledger)).toContain("0 apply rounds");
  });
});
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VaultPaths } from "./utils.js";

/**
 * pi-mem-wiki fork (M3): consolidation accept-rate ledger — the evidence the
 * autonomy ladder needs, computed from the append-only events.jsonl (not
 * agent-editable; meta/** guardrail). Measure-only by design: this module
 * NEVER grants autonomy — it reports whether the M3 gate conditions hold
 * (rounds ≥ 3 AND cold accept-rate ≥ 0.9) so the auto-apply path can refuse
 * otherwise. "all-cold" style single-decision rounds are not a thing in the
 * event format (we record per-item ids), so every item id counts individually.
 */

export interface ConsolidationLedger {
  /** Distinct proposals generated ({kind:"consolidate"} events). */
  proposals: number;
  /** Apply rounds ({kind:"consolidate-apply"} events). */
  applyRounds: number;
  /** Item-level decisions summed over rounds. */
  accepts: number;
  rejects: number;
  /** Cold-action subset. */
  coldAccepts: number;
  coldRejects: number;
  /** accept / (accept + reject) over cold items; null when nothing decided. */
  coldRate: number | null;
  /**
   * Apply rounds in which at least one COLD item decision occurred — only
   * these count toward the cold-autonomy gate. Rounds that decided no cold
   * items (e.g. hub-only rounds) neither raise nor lower the cold rate:
   * "reviewed, but nothing cold to judge" must not unlock cold autonomy.
   * (Rubber-stamp guard, per the v3 plan's own warning.)
   */
  coldRounds: number;
  /** The M3 gate: coldRounds ≥ 3 && coldRate ≥ 0.9. */
  autoApplyEligible: boolean;
}

const COLD_PREFIX = "cold:";

function actionOf(itemId: string): "cold" | "other" {
  return itemId.startsWith(COLD_PREFIX) ? "cold" : "other";
}

export function computeConsolidationLedger(paths: VaultPaths): ConsolidationLedger {
  const eventsPath = join(paths.meta, "events.jsonl");
  let proposals = 0;
  let applyRounds = 0;
  let accepts = 0;
  let rejects = 0;
  let coldAccepts = 0;
  let coldRejects = 0;
  let coldRounds = 0;
  try {
    const lines = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.kind === "consolidate") proposals++;
      else if (event.kind === "consolidate-apply") {
        applyRounds++;
        const accepted = Array.isArray(event.accepted) ? (event.accepted as string[]) : [];
        const rejected = Array.isArray(event.rejected) ? (event.rejected as string[]) : [];
        for (const id of accepted) {
          accepts++;
          if (actionOf(id) === "cold") coldAccepts++;
        }
        for (const id of rejected) {
          rejects++;
          if (actionOf(id) === "cold") coldRejects++;
        }
        // A round counts toward the cold gate only if it actually decided
        // cold items (accepts or rejects).
        const roundColdDecisions =
          accepted.filter((id) => actionOf(id) === "cold").length +
          rejected.filter((id) => actionOf(id) === "cold").length;
        if (roundColdDecisions > 0) coldRounds++;
      }
    }
  } catch {
    // no events file yet → zero ledger
  }
  const decided = coldAccepts + coldRejects;
  const coldRate = decided > 0 ? coldAccepts / decided : null;
  const autoApplyEligible = coldRounds >= 3 && coldRate !== null && coldRate >= 0.9;
  return {
    proposals,
    applyRounds,
    accepts,
    rejects,
    coldAccepts,
    coldRejects,
    coldRounds,
    coldRate,
    autoApplyEligible,
  };
}

/** Human-readable ledger line for wiki_status. */
export function ledgerLine(ledger: ConsolidationLedger): string {
  if (ledger.applyRounds === 0) {
    return `Consolidation ledger: ${ledger.proposals} proposal(s) generated, 0 apply rounds yet`;
  }
  const rate = ledger.coldRate === null ? "n/a" : `${Math.round(ledger.coldRate * 100)}%`;
  return `Consolidation ledger: ${ledger.applyRounds} round(s), cold accept-rate ${rate} (cold ${ledger.coldAccepts}/${ledger.coldAccepts + ledger.coldRejects}), auto-apply ${ledger.autoApplyEligible ? "ELIGIBLE" : "not eligible"}`;
}
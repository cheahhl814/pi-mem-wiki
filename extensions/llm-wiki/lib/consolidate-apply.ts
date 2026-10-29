import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendEvent, rebuildMetadataLight } from "./metadata.js";
import {
  createKnowledgeDocument,
  patchKnowledgeDocument,
  readKnowledgeDocumentFile,
  serializeKnowledgeDocument,
  writeKnowledgeDocumentFile,
} from "./knowledge-document.js";
import { fmtDate, slugify, type VaultPaths } from "./utils.js";
import { loadTaskConfig } from "./task-config.js";
import { assertWritableVault } from "./vault-format.js";
import { computeConsolidationLedger, type ConsolidationLedger } from "./consolidate-ledger.js";

/**
 * pi-mem-wiki fork (M2): apply a consolidation proposal — DRY-RUN by default,
 * human-confirmed to write, move-never-delete.
 *
 * Safety contract (from the 3-seat brainstorm + opus review):
 *  - The apply step reads discoveries/consolidate.json ITEMS, never markdown.
 *  - Freshness abort: if ANY page referenced by the proposal changed since
 *    generation (sha256), the whole apply refuses — "re-run wiki_consolidate".
 *  - confirm format: `<proposalId>:<acceptedCount>` (acceptedCount = applyable
 *    items AFTER skips). An explicit but mismatched confirm is refused, never
 *    silently downgraded; an ABSENT confirm is a dry run.
 *  - cold → frontmatter lifecycle: cold ONLY. The file never moves or deletes.
 *  - supersede → requires a user-named target per item; items without one are
 *    skipped and reported. The tool never guesses a target.
 *  - hub → creates the hub page linking the cluster, only when explicitly
 *    accepted; skips when the page already exists.
 *  - MERGE is out of scope (lossy, LLM-authored, hard to review).
 *  - Exactly ONE {kind:"consolidate-apply"} event per run; then metadata rebuild.
 */

export interface ConsolidateApplyInput {
  proposalId: string;
  /** Item ids to apply ("cold:<pageId>" | "supersede:<pageId>" | "hub:<tag>"). */
  accept: string[];
  /** Item ids explicitly rejected (recorded in the event for the ledger). */
  reject?: string[];
  /** `<proposalId>:<acceptedCount>` — absent = dry run; mismatched = refuse. */
  confirm?: string;
  /** For supersede items: first page id → named target id (required per item). */
  supersedeTargets?: Record<string, string>;
  /** pi-mem-wiki fork (M3): TRUE = derive accept from all cold items (cap 25),
   * gated on llm-wiki.autoApplyCold AND the ledger. Input.accept is REQUIRED
   * to be empty when auto is set. Non-cold items are ineligible by design. */
  auto?: boolean;
}

export interface ConsolidateApplyDiff {
  item: string;
  action: string;
  changes: Array<{ file: string; id: string; set: Record<string, string> }>;
  creates?: Array<{ file: string; id: string; what: string }>;
}

export type ConsolidateApplyResult =
  | {
      ok: true;
      dryRun: boolean;
      proposalId: string;
      plan: ConsolidateApplyDiff[];
      accepted: string[];
      rejected: string[];
      skipped: Array<{ id: string; reason: string }>;
      report: string;
    }
  | {
      ok: false;
      code:
        | "no_proposal"
        | "proposal_stale"
        | "confirm_mismatch"
        | "unknown_item"
        | "auto_apply_refused";
      message: string;
    };

interface StoredItem {
  id: string;
  action: "cold" | "supersede" | "hub";
  pages: string[];
  hashes: Record<string, string>;
  reason?: string;
  tag?: string;
}

interface StoredProposal {
  proposal_id: string;
  items: StoredItem[];
}

function hashFile(file: string): string {
  try {
    return createHash("sha256").update(readFileSync(file, "utf8")).digest("hex");
  } catch {
    return ""; // unreadable/missing page → empty hash; treated as drift
  }
}

function hubPageName(tag: string): string {
  return `${slugify(tag)}-hub`;
}

// ── M3: autoApplyCold — measured autonomy, cold-only, capped ──

export const AUTO_APPLY_COLD_CAP = 25;

/**
 * pi-mem-wiki fork (M3): derive the auto-apply accept list from a stored
 * proposal. Refuses unless (a) llm-wiki.autoApplyCold is explicitly true AND
 * (b) the ledger shows ≥3 apply rounds AND ≥0.9 cold accept-rate. Only ever
 * returns COLD item ids, capped at 25 per run. Pure function over (items,
 * config, ledger) so tests need no vault.
 */
export function deriveAutoApplyAccept(
  items: Array<{ id: string; action: "cold" | "supersede" | "hub" }>,
  autoApplyCold: boolean,
  ledger: ConsolidationLedger,
  cap = AUTO_APPLY_COLD_CAP,
): { allowed: true; accept: string[]; capped: boolean } | { allowed: false; reason: string } {
  if (autoApplyCold !== true) {
    return {
      allowed: false,
      reason:
        'llm-wiki.autoApplyCold is false (the default). Set it to true explicitly, then round(s) ≥ 3 and cold accept-rate ≥ 90% are still required.',
    };
  }
  if (ledger.applyRounds < 3) {
    return {
      allowed: false,
      reason: `Autonomy gate not met: ${ledger.applyRounds}/3 review rounds completed (ledger rounds ≥ 3 required).`,
    };
  }
  if (ledger.coldRate === null || ledger.coldRate < 0.9) {
    return {
      allowed: false,
      reason: `Autonomy gate not met: cold accept-rate ${ledger.coldRate === null ? "n/a" : Math.round(ledger.coldRate * 100) + "%"} < 90%.`,
    };
  }
  const cold = items.filter((i) => i.action === "cold").map((i) => i.id);
  return { allowed: true, accept: cold.slice(0, cap), capped: cold.length > cap };
}

export function applyConsolidate(
  paths: VaultPaths,
  input: ConsolidateApplyInput,
): ConsolidateApplyResult {
  assertWritableVault(paths);

  const proposalStorePath = join(paths.discoveries, "consolidate.json");
  let stored: StoredProposal;
  try {
    stored = JSON.parse(readFileSync(proposalStorePath, "utf8")) as StoredProposal;
  } catch {
    return {
      ok: false,
      code: "no_proposal",
      message: "No consolidation proposal found — run wiki_consolidate first.",
    };
  }
  if (stored.proposal_id !== input.proposalId) {
    return {
      ok: false,
      code: "no_proposal",
      message: `Stored proposal is ${stored.proposal_id}, not ${input.proposalId} — re-run wiki_consolidate.`,
    };
  }

  // ── M3 auto path: derive cold-only accept from the ledger-gated switch ──
  if (input.auto === true) {
    if (input.accept.length > 0) {
      return {
        ok: false,
        code: "auto_apply_refused",
        message: "auto: true derives its own cold-only accept list — pass accept: [] with auto, not a manual list.",
      };
    }
    const config = loadTaskConfig(paths.root) ?? ({} as { autoApplyCold?: boolean });
    const ledger = computeConsolidationLedger(paths);
    const derived = deriveAutoApplyAccept(stored.items, config.autoApplyCold === true, ledger);
    if (!derived.allowed) {
      return { ok: false, code: "auto_apply_refused", message: derived.reason };
    }
    input.accept = derived.accept;
  }

  const byId = new Map(stored.items.map((i) => [i.id, i] as const));
  const unknown = input.accept.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      code: "unknown_item",
      message: `Unknown item id(s): ${unknown.join(", ")}. Proposal ${input.proposalId} has: ${stored.items.map((i) => i.id).join(", ")}.`,
    };
  }

  // Freshness abort: ANY page in the proposal drifting invalidates the whole
  // apply (accepted or not — the proposal describes a vault state that no
  // longer holds).
  const drifted: string[] = [];
  for (const item of stored.items) {
    for (const [pageId, hash] of Object.entries(item.hashes)) {
      if (hashFile(join(paths.wiki, `${pageId}.md`)) !== hash) drifted.push(pageId);
    }
  }
  if (drifted.length > 0) {
    return {
      ok: false,
      code: "proposal_stale",
      message: `Proposal is stale: ${drifted.length} page(s) changed since generation (${drifted.slice(0, 5).join(", ")}${drifted.length > 5 ? "…" : ""}). Re-run wiki_consolidate.`,
    };
  }

  const rejectedSet = new Set(input.reject ?? []);
  const accepted = input.accept.filter((id) => !rejectedSet.has(id));
  const rejectedList = input.accept.filter((id) => rejectedSet.has(id));
  // Explicit rejects outside accept are ledger noise; still record them.
  for (const r of input.reject ?? []) if (!input.accept.includes(r)) rejectedList.push(r);

  // Build the plan.
  const plan: ConsolidateApplyDiff[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of accepted) {
    const item = byId.get(id)!;
    if (item.action === "cold") {
      plan.push({
        item: id,
        action: "cold",
        changes: item.pages.map((p) => ({
          file: join(paths.wiki, `${p}.md`),
          id: p,
          set: { lifecycle: "cold" },
        })),
      });
    } else if (item.action === "supersede") {
      const target = input.supersedeTargets?.[item.pages[0]]?.trim();
      if (!target) {
        skipped.push({ id, reason: "supersede requires a named target (supersedeTargets)" });
        continue;
      }
      plan.push({
        item: id,
        action: "supersede",
        changes: item.pages.map((p) => ({
          file: join(paths.wiki, `${p}.md`),
          id: p,
          set: { superseded_by: target },
        })),
      });
    } else if (item.action === "hub") {
      const hubName = hubPageName(item.tag ?? id.replace(/^hub:/, ""));
      const hubId = `concepts/${hubName}`;
      plan.push({
        item: id,
        action: "hub",
        changes: [],
        creates: [
          { file: join(paths.wiki, `${hubId}.md`), id: hubId, what: `hub page linking ${item.pages.length} packets` },
        ],
      });
    }
  }

  // Confirm gate: absent confirm = dry run; present confirm must equal
  // `<proposalId>:<applyableCount>` (skips already removed from the count).
  const expectedConfirm = `${input.proposalId}:${plan.length}`;
  if (input.confirm !== undefined && input.confirm !== expectedConfirm) {
    return {
      ok: false,
      code: "confirm_mismatch",
      message: `Confirm mismatch: expected "confirm": "${expectedConfirm}" (${plan.length} applyable item(s) after skips), received "${input.confirm}". Re-run as a dry run to re-count.`,
    };
  }
  const dryRun = input.confirm === undefined;

  const reportLines: string[] = [
    `Proposal ${input.proposalId} — ${dryRun ? "DRY RUN (nothing written)" : "APPLIED"}`,
    `Accepted: ${accepted.length}${rejectedList.length ? `, rejected: ${rejectedList.length}` : ""}${skipped.length ? `, skipped: ${skipped.length}` : ""}`,
    "",
  ];
  for (const p of plan) {
    reportLines.push(`- [${p.action}] ${p.item}`);
    for (const c of p.changes) {
      reportLines.push(
        `  ${dryRun ? "would set" : "set"} ${Object.entries(c.set)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")} in ${c.file}`,
      );
    }
    for (const c of p.creates ?? []) {
      reportLines.push(`  ${dryRun ? "would create" : "created"} ${c.what}: ${c.file}`);
    }
  }
  for (const s of skipped) reportLines.push(`- SKIPPED ${s.id}: ${s.reason}`);
  const report = reportLines.join("\n");

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      proposalId: input.proposalId,
      plan,
      accepted,
      rejected: rejectedList,
      skipped,
      report,
    };
  }

  // ── Confirmed apply: frontmatter-only writes via the serializer ──
  for (const p of plan) {
    if (p.action === "hub") {
      const creates = p.creates?.[0];
      if (!creates) continue;
      // Idempotency: an existing hub page means skip (readKnowledgeDocumentFile
      // would throw ENOENT on a genuinely missing page — use existsSync).
      if (existsSync(creates.file)) {
        skipped.push({ id: p.item, reason: `hub page already exists: ${creates.id}` });
        continue;
      }
      const item = byId.get(p.item)!;
      const tag = item.tag ?? p.item.replace(/^hub:/, "");
      const body = [
        `# ${tag} Hub`,
        "",
        "Map of content for this tag cluster (apply-accepted consolidation).",
        "",
        ...item.pages.map((pg) => `- [[${pg}]]`),
        "",
      ].join("\n");
      const doc = createKnowledgeDocument(
        creates.id,
        {
          type: "concept",
          title: `${tag.replace(/-/g, " ")} Hub`,
          tags: ["hub", "map-of-content"],
          status: "promoted",
          lifecycle: "promoted",
          created: fmtDate(),
          updated: fmtDate(),
        },
        body,
        [], // canonical sources: hub pages carry links in the body, not citations
      );
      mkdirSync(dirname(creates.file), { recursive: true });
      writeFileSync(creates.file, serializeKnowledgeDocument(doc), "utf8");
      continue;
    }
    for (const change of p.changes) {
      const parsed = readKnowledgeDocumentFile(change.file, change.id);
      if (!parsed.ok) {
        skipped.push({ id: p.item, reason: `page no longer parses: ${change.id}` });
        continue;
      }
      const patched = patchKnowledgeDocument(parsed.document, { fields: change.set });
      writeKnowledgeDocumentFile(change.file, patched);
    }
  }

  // Exactly ONE event, then metadata rebuild.
  appendEvent(paths, {
    kind: "consolidate-apply",
    proposal_id: input.proposalId,
    accepted,
    rejected: rejectedList,
    skipped,
  } as unknown as Parameters<typeof appendEvent>[1]);
  rebuildMetadataLight(paths);

  return {
    ok: true,
    dryRun: false,
    proposalId: input.proposalId,
    plan,
    accepted,
    rejected: rejectedList,
    skipped,
    report,
  };
}
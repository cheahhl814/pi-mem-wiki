import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, rebuildMetadataLight, type Registry } from "./metadata.js";
import {
  evaluatePageTime,
} from "./recall.js";
import { fmtDate, readJson, type VaultPaths, writeJson } from "./utils.js";
import { assertWritableVault } from "./vault-format.js";

/**
 * pi-mem-wiki fork (v2-b): proposal-only consolidation (the brainstorm's
 * single highest-blast-radius automation constraint). This scans the vault
 * for consolidation candidates and writes ONE durable proposal artifact —
 * it never writes or edits a wiki page. Approval-driven follow-up (a human,
 * or a next-session agent) turns the proposal into edits.

 Ladder mapping (captured → observed → promoted → archived | superseded):
  - PROMOTE: un-promoted packets (no lifecycle / captured|observed) clustered
    by their first tag, ranked by cluster size — candidate hub pages.
  - SUPERSEDE: stale pages (time semantics, fix 4) — candidate superseded_by.
  - COLD-POOL: stale OR relevance=low packets — candidates for
    lifecycle: cold/archive demotion (move-never-delete happens only when a
    human applies the proposal).
 */

export interface ConsolidateCounts {
  pages: number;
  unPromoted: number;
  stale: number;
  coldPoolCandidates: number;
  clusters: number;
}

export interface ConsolidateCluster {
  tag: string;
  pages: string[];
}

export interface ConsolidateResult {
  counts: ConsolidateCounts;
  proposalPath: string;
  report: string;
}

const UNPROMOTED = new Set(["", "captured", "observed"]);

function normalizeLifecycle(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function runConsolidate(
  paths: VaultPaths,
  opts: { staleThreshold?: string; maxClusters?: number } = {},
): ConsolidateResult {
  assertWritableVault(paths);
  const registry: Registry = readJson<Registry>(join(paths.meta, "registry.json"), {
    version: "1.0",
    last_updated: "",
    pages: {},
  });
  const maxClusters = opts.maxClusters ?? 10;

  const unPromoted: Array<{ id: string; entry: Registry["pages"][string] }> = [];
  const stale: Array<{ id: string; note?: string }> = [];
  const coldPool: string[] = [];
  const tagClusters = new Map<string, string[]>();

  for (const [id, entry] of Object.entries(registry.pages)) {
    const lifecycle = normalizeLifecycle(entry.lifecycle);
    const isPacketish = entry.type === "source" || entry.type === "observation";

    // Un-promoted: packets that never took a promotion step.
    if (isPacketish && UNPROMOTED.has(lifecycle)) {
      unPromoted.push({ id, entry });
      // Cluster by first tag (cheap tag-similarity proxy — exact set similarity
      // and embeddings are v3 work; the brainstorm scoped v2 to tag grouping).
      const tags = Array.isArray(entry.tags) ? entry.tags : [];
      const first = typeof tags[0] === "string" ? tags[0].trim() : "";
      if (first) {
        const list = tagClusters.get(first) ?? [];
        list.push(id);
        tagClusters.set(first, list);
      }
    }

    // Stale + cold-pool candidates via the same time semantics recall uses.
    const timeFields: Record<string, unknown> = {
      updated: entry.updated,
      stale_after: entry.stale_after,
      valid_until: entry.valid_until,
      superseded_by: entry.superseded_by,
    };
    const timeInfo = evaluatePageTime(timeFields);
    if (timeInfo.state === "stale" || timeInfo.state === "expired") {
      stale.push({ id, note: timeInfo.note });
      coldPool.push(id);
    } else if (
      (isPacketish && UNPROMOTED.has(lifecycle)) &&
      entry.relevance === "low"
    ) {
      coldPool.push(id);
    }
  }

  const clusters: ConsolidateCluster[] = [...tagClusters.entries()]
    .map(([tag, pages]) => ({ tag, pages: pages.slice().sort() }))
    .filter((c) => c.pages.length >= 3)
    .sort((a, b) => b.pages.length - a.pages.length)
    .slice(0, maxClusters);

  const counts: ConsolidateCounts = {
    pages: Object.keys(registry.pages).length,
    unPromoted: unPromoted.length,
    stale: stale.length,
    coldPoolCandidates: coldPool.length,
    clusters: clusters.length,
  };

  // ── Durable proposal artifact (outputs/proposals/, gitignored area but
  // human-reviewable). This is the ONLY write this tool performs. ──
  const proposalDir = join(paths.outputs, "proposals");
  mkdirSync(proposalDir, { recursive: true });
  const proposalPath = join(proposalDir, `consolidation-${fmtDate()}.md`);

  const lines: string[] = [
    "# Consolidation Proposal (proposal-only — nothing has been applied)",
    `Generated: ${fmtDate()}`,
    "",
    "Review each section, then apply manually or in a next-session agent call.",
    "This tool never writes wiki pages; the vault is authoritative in wiki/.",
    "",
    "## A) PROMOTE — tag clusters of un-promoted packets (candidate hub pages)",
    clusters.length
      ? clusters
          .map(
            (c) =>
              `- **${c.tag}** (${c.pages.length} packets) → propose \`concepts/${c.tag
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "")}-hub\` linking:\n` +
              c.pages.slice(0, 20).map((p) => `  - [[${p}]]`).join("\n") +
              (c.pages.length > 20 ? `\n  - … and ${c.pages.length - 20} more` : ""),
          )
          .join("\n")
      : "_No tag cluster reached the 3-packet bar._",
    "",
    "## B) SUPERSEDE — pages past their time validity",
    stale.length
      ? stale
          .slice(0, 50)
          .map((s) => `- [[${s.id}]] — ${s.note ?? "stale"} → propose superseding or updating`)
          .join("\n") + (stale.length > 50 ? `\n- … and ${stale.length - 50} more` : "")
      : "_None._",
    "",
    "## C) COLD-POOL — demotion candidates (lifecycle: cold; move-never-delete)",
    coldPool.length
      ? coldPool
          .slice(0, 100)
          .map((id) => `- [[${id}]]`)
          .join("\n") + (coldPool.length > 100 ? `\n- … and ${coldPool.length - 100} more` : "")
      : "_None._",
    "",
    "Applied-count expectations: after approval, the applying agent must append",
    "an event {kind: \"consolidate-apply\"} so the journal records who demoted what.",
  ];

  const report = lines.join("\n");
  writeFileSync(proposalPath, `${report}\n`, "utf8");
  // Machine-readable counts for wiki_status/agents (extension-owned projection).
  writeJson(join(paths.discoveries, "consolidate.json"), {
    counts,
    proposalPath,
    generated: new Date().toISOString(),
  });

  // Durable journal (#303 follow-through): the proposal's existence is an
  // authoritative event, not a transient report.
  appendEvent(paths, {
    kind: "consolidate",
    proposal_path: proposalPath,
    ...counts,
  } as unknown as Parameters<typeof appendEvent>[1]);
  rebuildMetadataLight(paths);

  return { counts, proposalPath, report };
}
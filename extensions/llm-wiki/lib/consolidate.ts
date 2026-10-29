import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * pi-mem-wiki fork (M2-a): one machine-readable apply item. `id` is the key
 * (`cold:<pageId>` | `supersede:<pageId>` | `hub:<tag>`); `hashes` records the
 * sha256 of each referenced page at proposal time — the apply step aborts if
 * ANY of them drifted.
 */
export interface ConsolidateItem {
  id: string;
  action: "cold" | "supersede" | "hub";
  pages: string[];
  reason: string;
  hashes: Record<string, string>;
  tag?: string;
  hubName?: string;
}

export interface ConsolidateResult {
  counts: ConsolidateCounts;
  proposalId: string;
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
  // pi-mem-wiki fork (M2-a): machine-readable apply items. The apply step reads
  // THESE — never the markdown — keyed ids, per-page content hashes for the
  // freshness abort. Shape: {id, action, pages, reason, hashes, tag?, hubName?}.
  const items: ConsolidateItem[] = [];

  const hashPage = (id: string): string => {
    const file = join(paths.wiki, `${id}.md`);
    try {
      return createHash("sha256").update(readFileSync(file, "utf8")).digest("hex");
    } catch {
      return ""; // unreadable page → empty hash; apply treats it as drift
    }
  };

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
    const isStaleOrExpired = timeInfo.state === "stale" || timeInfo.state === "expired";
    if (isStaleOrExpired) {
      stale.push({ id, note: timeInfo.note });
      coldPool.push(id);
    } else if (
      (isPacketish && UNPROMOTED.has(lifecycle)) &&
      entry.relevance === "low"
    ) {
      coldPool.push(id);
    }
    // Item construction (M2-a):
    if (isPacketish && UNPROMOTED.has(lifecycle) && (isStaleOrExpired || entry.relevance === "low")) {
      items.push({
        id: `cold:${id}`,
        action: "cold",
        pages: [id],
        reason:
          timeInfo.note ??
          (entry.relevance === "low" ? "relevance: low un-promoted packet" : "stale un-promoted packet"),
        hashes: { [id]: hashPage(id) },
      });
    } else if (!isPacketish && isStaleOrExpired) {
      // Non-packet pages past validity: supersede (needs a user-named target;
      // apply skips items without one).
      items.push({
        id: `supersede:${id}`,
        action: "supersede",
        pages: [id],
        reason: timeInfo.note ?? "past time validity",
        hashes: { [id]: hashPage(id) },
      });
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

  // Hub items — one per cluster (apply creates the hub page ONLY when the
  // item is explicitly accepted; folder = the cluster's dominant folder).
  for (const c of clusters) {
    items.push({
      id: `hub:${c.tag}`,
      action: "hub",
      pages: c.pages,
      reason: `${c.pages.length} un-promoted packets clustered by tag`,
      tag: c.tag,
      hashes: Object.fromEntries(c.pages.map((p) => [p, hashPage(p)])),
    });
  }

  // ── Durable proposal artifact (outputs/proposals/, gitignored area but
  // human-reviewable). This is the ONLY write this tool performs. ──
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const proposalId = `P-${fmtDate()}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const proposalDir = join(paths.outputs, "proposals");
  mkdirSync(proposalDir, { recursive: true });
  const proposalPath = join(proposalDir, `consolidation-${proposalId}.md`);

  const lines: string[] = [
    "# Consolidation Proposal (proposal-only — nothing has been applied)",
    `Proposal: ${proposalId}`,
    `Generated: ${fmtDate()}`,
    "",
    "Review each section, then apply with wiki_apply_consolidate",
    "(dry-run first; confirm format `<proposalId>:<acceptedCount>`).",
    "This tool never writes wiki pages; the vault is authoritative in wiki/.",
    "",
    `Machine items: ${items.length} (${items.filter((i) => i.action === "cold").length} cold / ${items.filter((i) => i.action === "supersede").length} supersede / ${items.filter((i) => i.action === "hub").length} hub)`,
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
  // Machine-readable items + counts for wiki_status/agents and the apply step
  // (extension-owned projection; the apply step reads THIS, never markdown).
  writeJson(join(paths.discoveries, "consolidate.json"), {
    proposal_id: proposalId,
    proposalPath,
    counts,
    items,
    generated: new Date().toISOString(),
  });

  // Durable journal (#303 follow-through): the proposal's existence is an
  // authoritative event, not a transient report.
  appendEvent(paths, {
    kind: "consolidate",
    proposal_id: proposalId,
    proposal_path: proposalPath,
    ...counts,
  } as unknown as Parameters<typeof appendEvent>[1]);
  rebuildMetadataLight(paths);

  return { counts, proposalId, proposalPath, report };
}
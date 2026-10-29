import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKnowledgeDocument, serializeKnowledgeDocument } from "./knowledge-document.js";
import {
  buildResolvedBacklinks,
  buildWikilinkIndex,
  resolveWikilink,
} from "./knowledge-links.js";
import { repairLegacyKnowledgeDocuments } from "./legacy-repair.js";
import { appendEvent, rebuildMetadata, rebuildMetadataLight } from "./metadata.js";
import { readQmdIndexStatus } from "./qmd-indexing.js";
import { fmtDate, slugify, type VaultPaths, writeJson } from "./utils.js";
import {
  assertWritableVault,
  compareCodePoint,
  discoverKnowledgeDocuments,
  inspectVaultFormat,
} from "./vault-format.js";

/**
 * pi-mem-wiki fork: resolve an unresolved link target into a class before it
 * becomes a lint finding.
 *  - "tag": bare single-token wikilinks ([[notion]]) — tag-like references, not pages.
 *  - "source-ref": raw/** paths into immutable source-packet stores.
 *  - "page": anything else that should resolve to a wiki page.
 */
export function classifyUnresolvedTarget(target: string): "tag" | "source-ref" | "page" {
  const cleaned = target.trim().replace(/\\$/, "");
  if (!cleaned.includes("/")) return "tag";
  if (cleaned === "raw" || cleaned.startsWith("raw/")) return "source-ref";
  return "page";
}

/**
 * Wiki health scan. Extracted verbatim from tools.ts (issue #77) so the Pi tool
 * and the MCP server run the exact same lint implementation (Phase 1 of #221).
 */
export async function runWikiLint(paths: VaultPaths, autoFix: boolean): Promise<string> {
  assertWritableVault(paths);
  const qmdStatus = await readQmdIndexStatus(paths);
  let repair: ReturnType<typeof repairLegacyKnowledgeDocuments> | undefined;
  if (autoFix) {
    let projection = rebuildMetadata(paths);
    repair = !projection.ok ? repairLegacyKnowledgeDocuments(paths) : undefined;
    if (repair?.repaired) projection = rebuildMetadata(paths);
    if (!projection.ok) {
      return [
        "# Wiki Lint Report",
        "",
        repair?.repaired ? `Legacy pages repaired: ${repair.repaired}` : "",
        repair?.manifestPath ? `Repair manifest: ${repair.manifestPath}` : "",
        "Projection-blocking diagnostics:",
        ...projection.diagnostics.map(
          (diagnostic) => `- ${diagnostic.code}: ${diagnostic.path}: ${diagnostic.message}`,
        ),
      ]
        .filter(Boolean)
        .join("\n");
    }
  } else {
    const vault = inspectVaultFormat(paths);
    const audit = discoverKnowledgeDocuments(paths);
    const diagnostics = [...vault.diagnostics, ...audit.diagnostics];
    if (vault.blocking || audit.blocking) {
      return [
        "# Wiki Lint Report",
        "",
        "Projection-blocking diagnostics:",
        ...diagnostics.map(
          (diagnostic) => `- ${diagnostic.code}: ${diagnostic.path}: ${diagnostic.message}`,
        ),
      ].join("\n");
    }
  }

  const discovery = discoverKnowledgeDocuments(paths);
  const pages = discovery.documents;
  const wikilinkIndex = buildWikilinkIndex(pages.map((page) => page.id));
  const inbound = Object.fromEntries(pages.map((page) => [page.id, 0]));
  const gapSources = new Map<string, Set<string>>();
  const findings: string[] = [];
  let missingPages = 0;
  let contradictions = 0;
  // pi-mem-wiki fork (v2 follow-up, review low-10): dangling supersession count.
  let danglingSupersessions = 0;
  // pi-mem-wiki fork: classify unresolved targets before they become findings.
  // Bare tokens (no "dir/" prefix) are tag-like references, and "raw/**" targets
  // are immutable source-packet paths — neither is a missing PAGE, so neither
  // counts toward the missing-page total nor is ever stub-able by auto-fix.
  let tagLikeLinks = 0;
  let sourcePacketLinks = 0;

  for (const page of pages) {
    const resolved = buildResolvedBacklinks(page.id, page.body, wikilinkIndex);
    for (const target of resolved.targets) inbound[target]++;
    for (const unresolved of resolved.unresolved) {
      // pi-mem-wiki fork: classify ONCE per target (review low-13).
      const targetClass = classifyUnresolvedTarget(unresolved.target);
      if (targetClass === "tag") {
        tagLikeLinks++;
      } else if (targetClass === "source-ref") {
        sourcePacketLinks++;
      } else {
        const sources = gapSources.get(unresolved.target) ?? new Set<string>();
        sources.add(page.id);
        gapSources.set(unresolved.target, sources);
        missingPages++;
        findings.push(`Missing page: ${unresolved.target} (in ${page.id})`);
      }
    }
    for (const d of resolved.diagnostics) {
      if (d.code === "link_ambiguous") {
        findings.push(d.message.replace("Ambiguous wikilink: ", "Ambiguous: "));
      }
    }

    // pi-mem-wiki fork (v2 follow-up, review low-10): a page that declares
    // superseded_by must point at a page that EXISTS. A dangling supersession
    // silently decays a live page (×0.1) with no way to see why.
    const supersededByRaw =
      (page.frontmatter?.superseded_by as string | undefined) ?? undefined;
    if (typeof supersededByRaw === "string" && supersededByRaw.trim()) {
      const target = supersededByRaw.trim().replace(/^\[\[|\]\]$/g, "").trim();
      const resolution = resolveWikilink(target, wikilinkIndex);
      if (resolution.kind !== "resolved") {
        danglingSupersessions++;
        findings.push(
          `Dangling supersession: ${page.id} → ${resolution.kind === "ambiguous" ? `ambiguous ${target}` : target} (page still decays ×0.1 until fixed)`,
        );
      }
    }
  }

  let orphans = 0;
  for (const page of pages) {
    if (inbound[page.id] === 0) {
      orphans++;
      findings.push(`Orphan: ${page.id} has no inbound links`);
    }
    if (page.body.includes("⚠️ **Contradiction")) {
      contradictions++;
      findings.push(`Contradiction flagged in ${page.id}`);
    }
  }

  const gaps = [...gapSources.entries()]
    .map(([topic, sources]) => ({ topic, mentionedBy: [...sources].sort(compareCodePoint) }))
    .sort((left, right) => compareCodePoint(left.topic, right.topic));
  let fixesApplied = 0;
  if (autoFix) {
    for (const gap of gaps) {
      if (gap.mentionedBy.length < 2) continue;
      // pi-mem-wiki fork: only folder-qualified concepts/ targets are stub-able.
      // Upstream also accepted bare tokens here ("[[notion]]" → concepts/notion.md),
      // which is how junk stub pages were minted from tag-like links.
      const parts = gap.topic.split("/");
      const name = parts.length === 2 && parts[0] === "concepts" ? parts[1] : "";
      if (!name || slugify(name) !== name) continue;
      const pagePath = join(paths.wiki, "concepts", `${name}.md`);
      mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
      const document = createKnowledgeDocument(
        `concepts/${name}.md`,
        {
          type: "concept",
          title: name.replace(/-/g, " "),
          created: fmtDate(),
          updated: fmtDate(),
          status: "stub",
        },
        `_Stub auto-created by lint. Expand with content from: ${gap.mentionedBy
          .map((source) => `[${source}](/${source}.md)`)
          .join(", ")}_`,
      );
      try {
        writeFileSync(pagePath, serializeKnowledgeDocument(document), {
          encoding: "utf8",
          flag: "wx",
        });
        fixesApplied++;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  const reportLines = [
    "# Wiki Lint Report",
    `Generated: ${fmtDate()}`,
    "",
    "## Summary",
    `- Total pages: ${pages.length}`,
    `- Orphans: ${orphans}`,
    `- Missing pages: ${missingPages}`,
    `- Contradictions: ${contradictions}`,
    danglingSupersessions > 0
      ? `- Dangling supersessions: ${danglingSupersessions}`
      : "",
    tagLikeLinks > 0
      ? `- Tag-like links (informational, not pages): ${tagLikeLinks}`
      : "",
    sourcePacketLinks > 0
      ? `- Source-packet links (informational): ${sourcePacketLinks}`
      : "",
    autoFix ? `- Missing-page fixes applied: ${fixesApplied}` : "",
    repair?.repaired ? `- Legacy pages repaired: ${repair.repaired}` : "",
    repair?.manifestPath ? `- Repair manifest: ${repair.manifestPath}` : "",
    "",
    "## Findings",
    findings.length ? findings.map((finding) => `- ${finding}`).join("\n") : "✅ No issues found!",
    "",
  ].filter(Boolean);
  const reportPath = autoFix ? join(paths.outputs, `lint-${fmtDate()}.md`) : undefined;
  // The gap snapshot is generated discovery metadata consumed by wiki_status:
  // persist it on every successful lint so status never reports a stale count.
  // Corrective actions below (report, event, meta rebuild) stay autoFix-only.
  // mkdir mirrors the autoFix report write below: on a fresh checkout the
  // gitignored .discoveries dir does not exist yet (issue #203).
  mkdirSync(paths.discoveries, { recursive: true });
  writeJson(join(paths.discoveries, "gaps.json"), {
    gaps,
    generated: new Date().toISOString(),
  });
  if (autoFix && reportPath) {
    mkdirSync(paths.outputs, { recursive: true });
    writeFileSync(reportPath, `${reportLines.join("\n")}\n`, "utf8");
    appendEvent(paths, {
      kind: "lint",
      orphans,
      missing_pages: missingPages,
      contradictions,
      auto_fix: true,
      legacy_pages_repaired: repair?.repaired ?? 0,
    });
    rebuildMetadataLight(paths);
  }

  const qmdFindings: string[] = [];
  if (qmdStatus.state === "stale") {
    const components = JSON.stringify(
      qmdStatus.repairComponents.length > 0 ? qmdStatus.repairComponents : ["lexical"],
    );
    qmdFindings.push(
      `- QMD index stale (${qmdStatus.indexedManifestHash ? "manifest or model changed" : ""}): repair with \`wiki_reindex(scope="changed", components=${components}, vault="active")\``,
    );
  } else if (qmdStatus.state === "recovering") {
    qmdFindings.push(
      `- QMD swap interrupted (${qmdStatus.swapPhase ?? ""}): restart recovery via \`wiki_reindex(vault="active")\``,
    );
  } else if (qmdStatus.state === "error") {
    qmdFindings.push(
      `- QMD index error: ${qmdStatus.issues[0]?.message ?? "repair with wiki_reindex"} — \`wiki_reindex(scope="changed", components=${JSON.stringify(qmdStatus.repairComponents.length > 0 ? qmdStatus.repairComponents : ["lexical"])}, vault="active")\``,
    );
  } else if (qmdStatus.state === "missing") {
    qmdFindings.push("- QMD index not built yet (informational): run wiki_reindex to build it");
  }

  return [
    "🧹 **LLM Wiki lint complete**",
    "",
    `- Pages: ${pages.length}`,
    `- Orphans: ${orphans}`,
    `- Missing: ${missingPages}`,
    `- Contradictions: ${contradictions}`,
    danglingSupersessions > 0
      ? `- Dangling supersessions: ${danglingSupersessions}`
      : "",
    tagLikeLinks > 0 ? `- Tag-like links (informational): ${tagLikeLinks}` : "",
    sourcePacketLinks > 0 ? `- Source-packet links (informational): ${sourcePacketLinks}` : "",
    autoFix ? `- Missing-page fixes: ${fixesApplied}` : "",
    repair?.repaired ? `- Legacy pages repaired: ${repair.repaired}` : "",
    "",
    reportPath ? `📄 Report: \`${reportPath}\`` : "",
    repair?.manifestPath ? `🛟 Repair manifest: \`${repair.manifestPath}\`` : "",
    gaps.length ? `💡 ${gaps.length} knowledge gap(s) tracked` : "",
    "",
    "## QMD Index",
    `- State: ${qmdStatus.state}`,
    ...qmdFindings,
  ]
    .filter(Boolean)
    .join("\n");
}

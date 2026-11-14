import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { demoteToCold } from "./consolidate-apply.js";
import {
  createKnowledgeDocument,
  parseKnowledgeDocument,
  serializeKnowledgeDocument,
} from "./knowledge-document.js";
import { appendEvent, rebuildMetadataLight } from "./metadata.js";
import type { ResolveCtx, Runtime } from "./runtime.js";
import {
  DIGEST_MAX_BYTES,
  DIGEST_MAX_LINES,
  DIGESTS_DIR,
  resolveSessionVault,
  SESSIONS_DIR,
  workspaceSlug,
} from "./session-pages.js";
import { runSubAgent } from "./subagent.js";
import type { TaskConfig } from "./task-config.js";
import type { VaultPaths } from "./utils.js";
import { assertWritableVault } from "./vault-format.js";

/**
 * pi-mem-wiki fork: gated digest compaction (DESIGN-session-memory.md §4).
 *
 * Raw session pages → one model call → `digests/<ws>.md` (atomic tmp+rename),
 * then the consumed raw pages are cold-demoted. Everything up to the digest
 * rename is all-or-nothing; demotion after it is idempotent and retried on the
 * next run from `digested_through`.
 */

/** Text-in/text-out model call. Injectable so tests never touch a provider. */
export type Complete = (systemPrompt: string, userPrompt: string) => Promise<string>;

export const DIGEST_MIN_SESSIONS = 5;
export const DIGEST_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DIGEST_LOCK_STALE_MS = 30 * 60 * 1000;
export const DIGEST_BATCH_CAP = 50;
const SECTIONS = ["Decisions", "Facts", "Open", "Watchlist"] as const;
/** Only settled history rolls to the archive; Open/Watchlist stay live. */
const ARCHIVABLE = new Set<string>(["Decisions", "Facts"]);

interface RawSessionPage {
  id: string;
  closed: string;
  lifecycle: string;
  body: string;
}

interface DigestState {
  digestedThrough?: string;
  updated?: string;
  consumed: number;
  body: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v instanceof Date ? v.toISOString() : "";
}

export function listSessionPages(paths: VaultPaths, workspace: string): RawSessionPage[] {
  const dir = join(paths.wiki, SESSIONS_DIR, workspace);
  if (!existsSync(dir)) return [];
  const pages: RawSessionPage[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || name.startsWith(".")) continue;
    const id = `${SESSIONS_DIR}/${workspace}/${name.slice(0, -3)}`;
    const parsed = parseKnowledgeDocument(readFileSync(join(dir, name), "utf8"), `${id}.md`);
    if (!parsed.ok || parsed.document.frontmatter.type !== "session") continue;
    const closed = str(parsed.document.extensions.closed);
    if (!closed) continue; // not frozen → not consumable
    pages.push({
      id,
      closed,
      lifecycle: str(parsed.document.frontmatter.lifecycle),
      body: parsed.document.body,
    });
  }
  return pages.sort((a, b) => a.closed.localeCompare(b.closed) || a.id.localeCompare(b.id));
}

function digestPath(paths: VaultPaths, workspace: string): string {
  return join(paths.wiki, DIGESTS_DIR, `${workspace}.md`);
}

function readDigest(paths: VaultPaths, workspace: string): DigestState | null {
  const file = digestPath(paths, workspace);
  if (!existsSync(file)) return null;
  const parsed = parseKnowledgeDocument(
    readFileSync(file, "utf8"),
    `${DIGESTS_DIR}/${workspace}.md`,
  );
  if (!parsed.ok) throw new Error(`digest ${file} does not parse — fix it before compacting`);
  const ext = parsed.document.extensions;
  return {
    digestedThrough: str(ext.digested_through) || undefined,
    updated: str(parsed.document.frontmatter.updated) || undefined,
    consumed: typeof ext.raw_pages_consumed === "number" ? ext.raw_pages_consumed : 0,
    body: parsed.document.body,
  };
}

export interface DigestPlan {
  workspace: string;
  /** Unconsumed raw pages (closed > digested_through), oldest first, capped. */
  pending: RawSessionPage[];
  /** Already-digested pages still raw (a prior demotion failed) — retried. */
  retryDemote: RawSessionPage[];
  /** null = gate open; otherwise why the build is refused. */
  refusal: string | null;
}

/** Evaluate the §4 gate without side effects. `force` skips count + interval, never the lock. */
export function planDigest(
  paths: VaultPaths,
  workspace: string,
  opts: { force?: boolean; now?: number } = {},
): DigestPlan {
  const now = opts.now ?? Date.now();
  const digest = readDigest(paths, workspace);
  const through = digest?.digestedThrough ?? "";
  const pages = listSessionPages(paths, workspace);
  const unconsumed = pages.filter((p) => p.closed > through);
  const retryDemote = pages.filter((p) => p.closed <= through && p.lifecycle === "raw");
  let refusal: string | null = null;
  if (unconsumed.length === 0) refusal = "no unconsumed session pages";
  else if (!opts.force && unconsumed.length < DIGEST_MIN_SESSIONS) {
    refusal = `${unconsumed.length}/${DIGEST_MIN_SESSIONS} unconsumed session pages`;
  } else if (!opts.force && digest?.updated) {
    const since = now - Date.parse(digest.updated);
    if (since < DIGEST_MIN_INTERVAL_MS) {
      refusal = `last digest ${Math.floor(since / 3_600_000)}h ago (< 24h)`;
    }
  }
  return { workspace, pending: unconsumed.slice(0, DIGEST_BATCH_CAP), retryDemote, refusal };
}

function lockPath(paths: VaultPaths, workspace: string): string {
  return join(paths.meta, `digest-${workspace}.lock`);
}

/** Exclusive create; a lock older than 30 min is reclaimed once. Returns false if held. */
function acquireLock(file: string, now: number): boolean {
  mkdirSync(join(file, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = now - statSync(file).mtimeMs;
      } catch {
        continue; // released between open and stat — retry
      }
      if (age <= DIGEST_LOCK_STALE_MS) return false;
      try {
        unlinkSync(file);
      } catch {
        // another reclaimer won the race; the retry decides
      }
    }
  }
  return false;
}

const DIGEST_SYSTEM_PROMPT = `You maintain a per-workspace memory digest built from raw session claims.

Output ONLY markdown with exactly these four sections, in this order:
## Decisions
## Facts
## Open
## Watchlist

Rules:
- Every item is one bullet: "- YYYY-MM-DD: text". Use absolute dates only — the date is the session's close date unless the claim states another; convert relative dates ("yesterday", "next week") to absolute ones.
- Merge the new session claims into the existing digest. Deduplicate.
- Remove open/todo items that later claims resolve (delete them; never strike through).
- "open:" and "todo:" claims go under Open; things to keep an eye on go under Watchlist.
- Never invent anything that is not in the existing digest or the session claims.
- Keep the whole digest under ${DIGEST_MAX_LINES} lines. No preamble, no closing remarks, no code fences.`;

function buildUserPrompt(existing: string, pages: RawSessionPage[]): string {
  const sessions = pages
    .map((p) => `### Session ${p.id} (closed ${p.closed.slice(0, 10)})\n\n${p.body}`)
    .join("\n\n");
  return `EXISTING DIGEST:\n\n${existing.trim() || "(none yet)"}\n\nNEW SESSION CLAIMS (oldest first):\n\n${sessions}`;
}

/**
 * Normalize model output to the four known sections, bullets only. Throws when
 * no known section is present (model ignored the format → write nothing).
 */
export function normalizeDigest(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>(SECTIONS.map((s) => [s, []]));
  let current: string[] | null = null;
  let seen = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      const name = SECTIONS.find((s) => s.toLowerCase() === h[1].toLowerCase());
      current = name ? (sections.get(name) ?? null) : null;
      if (name) seen = true;
      continue;
    }
    if (current && /^\s*-\s+\S/.test(line)) current.push(line.trim());
  }
  if (!seen) throw new Error("digest output has none of the required sections");
  return sections;
}

function renderSections(sections: Map<string, string[]>): string {
  return SECTIONS.map((s) => `## ${s}\n\n${(sections.get(s) ?? []).join("\n") || "_none_"}`).join(
    "\n\n",
  );
}

const bulletDate = (b: string) => /^-\s+(\d{4}-\d{2}-\d{2})/.exec(b)?.[1] ?? "0000-00-00";

/**
 * Enforce the cap by rolling the oldest dated Decisions/Facts bullets out.
 * Throws if the live sections alone still exceed it (write nothing; lint flags).
 */
export function splitOverflow(sections: Map<string, string[]>): {
  body: string;
  archived: string[];
} {
  const archived: string[] = [];
  const fits = (body: string) =>
    body.split("\n").length <= DIGEST_MAX_LINES &&
    Buffer.byteLength(body, "utf8") <= DIGEST_MAX_BYTES;
  let body = renderSections(sections);
  while (!fits(body)) {
    let oldest: { section: string; index: number; date: string } | null = null;
    for (const name of ARCHIVABLE) {
      (sections.get(name) ?? []).forEach((b, index) => {
        const date = bulletDate(b);
        if (!oldest || date < oldest.date) oldest = { section: name, index, date };
      });
    }
    if (!oldest) throw new Error("digest exceeds cap even after archiving all settled items");
    const { section, index } = oldest as { section: string; index: number };
    archived.push(
      ...(sections.get(section) ?? []).splice(index, 1).map((b) => `${b} (${section})`),
    );
    body = renderSections(sections);
  }
  return { body, archived };
}

function nextArchiveName(paths: VaultPaths, workspace: string): string {
  for (let n = 1; ; n++) {
    const name = `${workspace}-archive-${n}`;
    if (!existsSync(join(paths.wiki, DIGESTS_DIR, `${name}.md`))) return name;
  }
}

function tmpFor(file: string): string {
  return `${file}.tmp-${process.pid}-${randomUUID()}`;
}

export interface DigestResult {
  ok: boolean;
  code: "built" | "dry-run" | "refused" | "failed" | "locked" | "demote-only";
  report: string;
  digestId?: string;
  consumed?: string[];
  demoted?: string[];
}

/** Run compaction for one workspace. Never throws for model failure — returns ok:false. */
export async function runDigest(
  paths: VaultPaths,
  workspace: string,
  opts: { complete?: Complete; dryRun?: boolean; force?: boolean; now?: number } = {},
): Promise<DigestResult> {
  assertWritableVault(paths);
  const now = opts.now ?? Date.now();
  const plan = planDigest(paths, workspace, { force: opts.force, now });

  if (opts.dryRun) {
    const lines = [
      `Digest ${workspace} — DRY RUN (nothing written)`,
      plan.refusal
        ? `Gate: refused — ${plan.refusal}`
        : `Gate: open — would consume ${plan.pending.length} page(s)`,
      ...(plan.refusal
        ? []
        : plan.pending.map((p) => `  would digest + set lifecycle: cold in ${p.id}`)),
      ...plan.retryDemote.map((p) => `  would retry lifecycle: cold in ${p.id}`),
      existsSync(lockPath(paths, workspace)) ? "Lock: present" : "Lock: free",
    ];
    return { ok: true, code: "dry-run", report: lines.join("\n") };
  }
  if (plan.refusal && plan.retryDemote.length === 0) {
    return { ok: false, code: "refused", report: `Digest ${workspace} refused: ${plan.refusal}` };
  }

  const lock = lockPath(paths, workspace);
  if (!acquireLock(lock, now)) {
    return {
      ok: false,
      code: "locked",
      report: `Digest ${workspace}: another build holds ${lock}`,
    };
  }
  try {
    // Partial-failure retry: digested but never demoted (idempotent).
    const retried = demoteToCold(
      paths,
      plan.retryDemote.map((p) => p.id),
    ).demoted;
    if (plan.refusal) {
      return {
        ok: true,
        code: "demote-only",
        report: `Digest ${workspace} refused: ${plan.refusal}; retried demotion of ${retried.length} page(s)`,
        demoted: retried,
      };
    }
    if (!opts.complete) throw new Error("no model available for digest build");

    // ── All-or-nothing until the digest rename ──
    const prior = readDigest(paths, workspace);
    let output: string;
    try {
      output = await opts.complete(
        DIGEST_SYSTEM_PROMPT,
        buildUserPrompt(prior?.body ?? "", plan.pending),
      );
    } catch (err) {
      return {
        ok: false,
        code: "failed",
        report: `Digest ${workspace} failed (nothing written): ${(err as Error).message}`,
      };
    }
    let split: ReturnType<typeof splitOverflow>;
    try {
      split = splitOverflow(normalizeDigest(output));
    } catch (err) {
      return {
        ok: false,
        code: "failed",
        report: `Digest ${workspace} failed (nothing written): ${(err as Error).message}`,
      };
    }

    const nowIso = new Date(now).toISOString();
    const through = plan.pending[plan.pending.length - 1].closed;
    const digestId = `${DIGESTS_DIR}/${workspace}`;
    const digestFile = digestPath(paths, workspace);
    const digestDoc = createKnowledgeDocument(
      `${digestId}.md`,
      {
        type: "digest",
        title: `${workspace} digest`,
        workspace,
        updated: nowIso,
        digested_through: through,
        raw_pages_consumed: (prior?.consumed ?? 0) + plan.pending.length,
        lifecycle: "active",
        scope: `project:${workspace}`,
      },
      split.body,
    );
    mkdirSync(join(paths.wiki, DIGESTS_DIR), { recursive: true });
    const writes: Array<[string, string]> = [];
    if (split.archived.length > 0) {
      const name = nextArchiveName(paths, workspace);
      const archiveDoc = createKnowledgeDocument(
        `${DIGESTS_DIR}/${name}.md`,
        {
          type: "digest",
          title: `${workspace} digest archive (through ${nowIso.slice(0, 10)})`,
          workspace,
          updated: nowIso,
          archived: true,
          lifecycle: "active",
          scope: `project:${workspace}`,
        },
        `## Archived\n\n${split.archived.join("\n")}`,
      );
      writes.push([
        join(paths.wiki, DIGESTS_DIR, `${name}.md`),
        serializeKnowledgeDocument(archiveDoc),
      ]);
    }
    writes.push([digestFile, serializeKnowledgeDocument(digestDoc)]); // digest renames LAST
    const tmps = writes.map(([file, content]) => {
      const tmp = tmpFor(file);
      writeFileSync(tmp, content, "utf8");
      return [tmp, file] as const;
    });
    try {
      for (const [tmp, file] of tmps) renameSync(tmp, file);
    } finally {
      for (const [tmp] of tmps) {
        try {
          unlinkSync(tmp);
        } catch {
          // renamed
        }
      }
    }
    // ponytail: an archive renamed before a failed digest rename survives as an
    // extra recallable page (no loss); a two-file transaction would need a journal.

    // ── Idempotent follow-up: cold-demote consumed raw pages ──
    const consumed = plan.pending.map((p) => p.id);
    let demoted: string[] = [];
    try {
      demoted = demoteToCold(paths, consumed).demoted;
    } catch {
      // retried next run: these pages have closed <= digested_through and stay raw
    }
    appendEvent(paths, {
      kind: "session-digest",
      workspace,
      digest: digestId,
      consumed,
      demoted: [...retried, ...demoted],
      archived: split.archived.length,
    });
    rebuildMetadataLight(paths);
    return {
      ok: true,
      code: "built",
      report: `Digest ${workspace} built: consumed ${consumed.length} session page(s), demoted ${demoted.length}${split.archived.length ? `, archived ${split.archived.length} item(s)` : ""}.`,
      digestId,
      consumed,
      demoted,
    };
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

/**
 * Production `Complete`: the configured task model (or session model) via the
 * existing resolveModel + runSubAgent lane, one `submit` tool (§8.1-5).
 */
export function makeComplete(
  runtime: Runtime,
  ctx: ResolveCtx,
  opts: { timeoutMs?: number } = {},
): Complete {
  return async (systemPrompt, userPrompt) => {
    const resolved = await runtime.resolveModel(ctx);
    if (!resolved.ok) throw new Error(resolved.reason);
    let submitted = "";
    const submitTool = {
      name: "submit",
      label: "Submit",
      description: "Submit the complete result. Call exactly once.",
      parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
      execute: async (_id: string, params: { text: string }) => {
        submitted = params.text;
        return { content: [{ type: "text" as const, text: "Submitted. Stop." }], details: {} };
      },
    };
    await runSubAgent({
      model: resolved.model as Model<Api>,
      apiKey: resolved.apiKey,
      headers: resolved.headers,
      streamFn: resolved.streamFn as Parameters<typeof runSubAgent>[0]["streamFn"],
      env: resolved.env,
      systemPrompt: `${systemPrompt}\n\nDeliver the result by calling the submit tool exactly once with the full text.`,
      userPrompt,
      tools: [submitTool as unknown as AgentTool],
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
    if (!submitted.trim()) throw new Error("model did not submit a result");
    return submitted;
  };
}

/**
 * `wiki_digest` tool. Registered ONLY when `llm-wiki.sessionPages.enabled`.
 * Dry run is synchronous; a real build runs in the background lane.
 */
export function registerWikiDigest(pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerTool({
    name: "wiki_digest",
    label: "Wiki Digest",
    description:
      "Compact this workspace's raw session pages into its digest page and cold-demote the " +
      "consumed raw pages. Gated: ≥5 unconsumed sessions and ≥24h since the last build " +
      "(force skips both). dry_run reports the plan without writing.",
    promptSnippet: "Build or preview the session digest",
    promptGuidelines: [
      "Run wiki_digest with dry_run first when the user asks to compact sessions.",
    ],
    parameters: Type.Object({
      dry_run: Type.Optional(Type.Boolean({ description: "Report the plan; write nothing." })),
      force: Type.Optional(
        Type.Boolean({ description: "Skip the count and 24h gates (not the lock)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paths = resolveSessionVault(ctx.cwd ?? process.cwd());
      if (!paths) {
        return {
          content: [
            { type: "text", text: "No project wiki vault here — digests are project-only." },
          ],
          details: {} as Record<string, unknown>,
          isError: true,
        };
      }
      runtime.ensureConfig(ctx.cwd ?? paths.root);
      const workspace = workspaceSlug(paths, runtime.config);
      if (params.dry_run) {
        const r = await runDigest(paths, workspace, { dryRun: true, force: params.force });
        return {
          content: [{ type: "text", text: r.report }],
          details: { code: r.code } as Record<string, unknown>,
        };
      }
      dispatchDigest(runtime, ctx, paths, workspace, { force: params.force === true });
      return {
        content: [
          {
            type: "text",
            text: `Digest build for ${workspace} dispatched to the background; a report follows.`,
          },
        ],
        details: { dispatched: true } as Record<string, unknown>,
      };
    },
  });
}

/** Background build (same launchReported lane as wiki_consolidate). Single-flight per workspace. */
export function dispatchDigest(
  runtime: Runtime,
  ctx: ResolveCtx,
  paths: VaultPaths,
  workspace: string,
  opts: { force?: boolean; quiet?: boolean } = {},
): void {
  const launchCtx = { hasUI: ctx.hasUI, ui: ctx.ui };
  void runtime.launchReported(launchCtx, `digest:${paths.root}:${workspace}`, async () => {
    const r = await runDigest(paths, workspace, {
      complete: makeComplete(runtime, ctx),
      force: opts.force,
    });
    // Auto-trigger stays silent on gate refusals / lock contention; failures always report.
    if (opts.quiet && (r.code === "refused" || r.code === "locked")) return null;
    return `🗜️ ${r.report}`;
  });
}

/**
 * turn_end auto-trigger (§4 "Automatic"): cheap gate check, then a background
 * build. Only wired when the flag is on (index.ts).
 */
export function maybeAutoDigest(
  runtime: Runtime,
  ctx: ResolveCtx,
  cwd: string,
  config: TaskConfig,
): void {
  const paths = resolveSessionVault(cwd);
  if (!paths) return;
  const workspace = workspaceSlug(paths, config);
  if (runtime.isInFlight(`digest:${paths.root}:${workspace}`)) return;
  let plan: DigestPlan;
  try {
    plan = planDigest(paths, workspace);
  } catch {
    return; // unparseable digest: surfaced by lint / manual wiki_digest
  }
  if (plan.refusal && plan.retryDemote.length === 0) return;
  dispatchDigest(runtime, ctx, paths, workspace, { quiet: true });
}

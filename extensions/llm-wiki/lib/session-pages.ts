import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { detectHost } from "./host.js";
import { createKnowledgeDocument, serializeKnowledgeDocument } from "./knowledge-document.js";
import { appendEvent, rebuildMetadataLight } from "./metadata.js";
import { raceWithTimeout } from "./subagent.js";
import { loadTaskConfig, sessionPagesEnabled, type TaskConfig } from "./task-config.js";
import { getVaultPaths, resolveProjectVaultRoot, slugify, type VaultPaths } from "./utils.js";
import { assertWritableVault, inspectWritableVault } from "./vault-format.js";

/**
 * pi-mem-wiki fork: immutable per-session raw pages (DESIGN-session-memory.md §2.1).
 *
 * A session page is written ONCE, at close, and never rewritten. The single
 * permitted later mutation is `lifecycle: raw → cold` by digest compaction
 * (§8.1-2). `body_sha256` freezes the body so lint can detect edits.
 */

export const CLAIM_KINDS = ["decision", "fact", "open", "todo", "note"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export interface Claim {
  kind: ClaimKind;
  heading: string;
  body: string;
}

/** Folder (under wiki/) holding raw session pages. */
export const SESSIONS_DIR = "sessions";

/** Folder (under wiki/) holding derived per-workspace digests (§2.2). */
export const DIGESTS_DIR = "digests";
/** Digest hard cap (§2.2): ~200 lines / ~25 KB. */
export const DIGEST_MAX_LINES = 200;
export const DIGEST_MAX_BYTES = 25 * 1024;

export function isDigestPage(id: string, type: unknown): boolean {
  return type === "digest" && id.startsWith(`${DIGESTS_DIR}/`);
}

/**
 * Lint findings for session/digest pages (§8.1-7). Returns [] for any other
 * page, so vaults without the feature see no change.
 */
export function lintSessionMemoryPage(page: {
  id: string;
  body: string;
  frontmatter: { type?: unknown; lifecycle?: unknown };
  extensions: Record<string, unknown>;
}): string[] {
  const findings: string[] = [];
  if (isSessionPage(page.id, page.frontmatter.type)) {
    const frozen = page.extensions.body_sha256;
    if (typeof frozen !== "string" || frozen !== sessionBodyHash(page.body)) {
      findings.push(`Session page modified after close: ${page.id} (body_sha256 mismatch)`);
    }
    const lc = page.frontmatter.lifecycle;
    if (lc !== "raw" && lc !== "cold") {
      findings.push(
        `Session page has illegal lifecycle: ${page.id} (${String(lc)}; raw|cold only)`,
      );
    }
  } else if (isDigestPage(page.id, page.frontmatter.type)) {
    const lines = page.body.split("\n").length;
    const bytes = Buffer.byteLength(page.body, "utf8");
    if (lines > DIGEST_MAX_LINES || bytes > DIGEST_MAX_BYTES) {
      findings.push(
        `Digest over cap: ${page.id} (${lines} lines, ${bytes} bytes; cap ${DIGEST_MAX_LINES} lines / ${DIGEST_MAX_BYTES} bytes)`,
      );
    }
  }
  return findings;
}

/** Is this registry id / page a raw session page? Keys on type AND folder (§8.1-6). */
export function isSessionPage(id: string, type: unknown): boolean {
  return type === "session" && id.startsWith(`${SESSIONS_DIR}/`);
}

/**
 * Workspace slug: the ambient-recall project id, ALWAYS slugified before it
 * becomes a path segment (a verbatim projectId like `../x` must not escape).
 */
export function workspaceSlug(paths: VaultPaths, config?: TaskConfig): string {
  return slugify(config?.projectId ?? basename(paths.root)) || "workspace";
}

/**
 * Parse the strict claim grammar: `## <kind>: <heading>` followed by a body.
 * Anything else — preamble, unknown kinds, empty headings — is dropped.
 */
export function parseClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  let current: Claim | null = null;
  let inFence = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    const m = inFence ? null : /^##\s+([a-z]+)\s*:\s*(.+?)\s*$/i.exec(line);
    if (m) {
      const kind = m[1].toLowerCase() as ClaimKind;
      current = CLAIM_KINDS.includes(kind) ? { kind, heading: m[2], body: "" } : null;
      if (current) claims.push(current);
      continue;
    }
    // A heading of any other shape ends the current claim (its text is noise).
    if (!inFence && /^#{1,2}\s/.test(line)) {
      current = null;
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  for (const c of claims) c.body = c.body.trim();
  return claims;
}

export function renderClaims(claims: Claim[]): string {
  return claims
    .map((c) => (c.body ? `## ${c.kind}: ${c.heading}\n\n${c.body}` : `## ${c.kind}: ${c.heading}`))
    .join("\n\n");
}

/** Hash the frozen body; trailing whitespace is normalized by the serializer. */
export function sessionBodyHash(body: string): string {
  return createHash("sha256").update(body.replace(/\s+$/, "")).digest("hex");
}

export interface SessionPageInput {
  workspace: string;
  sessionId: string;
  claims: Claim[];
  /** ISO timestamp the session started (defaults to `closed`). */
  created?: string;
  /** ISO timestamp of freeze (defaults to now). */
  closed?: string;
  summaryQuality?: "model" | "fallback" | "manual";
  /** Rebuild metadata after write. Off at shutdown (budget); on for the tool. */
  rebuild?: boolean;
}

export interface SessionPageResult {
  id: string;
  pagePath: string;
}

/**
 * Write a raw session page. Publish is no-clobber: the content goes to a temp
 * file which is hard-linked into place (`link` fails with EEXIST instead of
 * overwriting), so an existing page can never be rewritten through this path.
 * Name collisions (a resumed session closing twice) get a numeric suffix.
 */
export function writeSessionPage(paths: VaultPaths, input: SessionPageInput): SessionPageResult {
  assertWritableVault(paths);
  if (input.claims.length === 0) throw new Error("session page needs at least one claim");
  const workspace = slugify(input.workspace) || "workspace";
  const closed = input.closed ?? new Date().toISOString();
  const created = input.created ?? closed;
  const short = slugify(input.sessionId).slice(0, 8) || "session";
  const stem = `${created.slice(0, 10)}-${short}`;
  const dir = join(paths.wiki, SESSIONS_DIR, workspace);
  mkdirSync(dir, { recursive: true });

  const body = renderClaims(input.claims);
  const tmp = join(dir, `.${stem}.tmp-${process.pid}-${randomUUID()}`);
  try {
    for (let n = 1; n <= 100; n++) {
      const name = n === 1 ? stem : `${stem}-${n}`;
      const id = `${SESSIONS_DIR}/${workspace}/${name}`;
      const doc = createKnowledgeDocument(
        `${id}.md`,
        {
          type: "session",
          title: `Session ${created.slice(0, 10)} ${short}`,
          workspace,
          session_id: input.sessionId,
          created,
          closed,
          lifecycle: "raw",
          scope: `project:${workspace}`,
          body_sha256: sessionBodyHash(body),
          ...(input.summaryQuality ? { summary_quality: input.summaryQuality } : {}),
        },
        body,
      );
      writeFileSync(tmp, serializeKnowledgeDocument(doc), "utf8");
      const pagePath = join(dir, `${name}.md`);
      try {
        linkSync(tmp, pagePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
      appendEvent(paths, { kind: "session-page", id, claims: input.claims.length });
      if (input.rebuild) rebuildMetadataLight(paths);
      return { id, pagePath };
    }
    throw new Error(`no free session page name for ${stem}`);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // never created, or already gone
    }
  }
}

/** Project vault for session material; null when only the personal fallback applies (§8.1-8). */
export function resolveSessionVault(cwd: string): VaultPaths | null {
  const root = resolveProjectVaultRoot(cwd);
  return root ? getVaultPaths(root) : null;
}

/**
 * Hidden manual-test surface (slice 1). Registered ONLY when
 * `llm-wiki.sessionPages.enabled` is true (index.ts), so flag-off sessions pay
 * nothing in the system prompt.
 */
export function registerWikiSessionCapture(pi: ExtensionAPI, getConfig: () => TaskConfig): void {
  pi.registerTool({
    name: "wiki_session_capture",
    label: "Wiki Session Capture",
    description:
      "Write an immutable raw session page from typed claim sections " +
      "(`## decision: …`, `## fact: …`, `## open: …`, `## todo: …`, `## note: …`). " +
      "Sections of any other shape are dropped. Raw pages are not recalled by default.",
    promptSnippet: "Freeze this session's claims into a raw session page",
    promptGuidelines: [
      "Normally the exit hook writes session pages; call wiki_session_capture only when asked.",
    ],
    parameters: Type.Object({
      claims: Type.String({ description: "Markdown of `## <kind>: <claim>` sections" }),
      session_id: Type.Optional(Type.String({ description: "Session id (default: timestamp)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paths = resolveSessionVault(ctx.cwd ?? process.cwd());
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        details: {} as Record<string, unknown>,
        isError: true,
      });
      if (!paths) return fail("No project wiki vault here — session pages are project-only.");
      const claims = parseClaims(params.claims);
      if (claims.length === 0) return fail("No `## <kind>: <claim>` sections found.");
      const result = writeSessionPage(paths, {
        workspace: workspaceSlug(paths, getConfig()),
        sessionId: params.session_id ?? `manual-${Date.now().toString(36)}`,
        claims,
        summaryQuality: "manual",
        rebuild: true,
      });
      return {
        content: [{ type: "text", text: `Session page written: \`${result.pagePath}\`` }],
        details: { id: result.id, claims: claims.length } as Record<string, unknown>,
      };
    },
  });
}

// ─── Exit hook (slice 4, §3) ─────────────────────────────

/** Text-in/text-out model call (same shape as session-digest's `Complete`). */
type CompleteFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** Bounded transcript tail fed to the summarizer (§3 step 2). */
export const TRANSCRIPT_MAX_CHARS = 40_000;
/** omp hard-caps session_shutdown handlers at 2000 ms (runtime.ts, #263). */
export const OMP_SUMMARY_BUDGET_MS = 1_500;

interface BranchEntry {
  type?: string;
  summary?: unknown;
  message?: { role?: string; content?: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

/** User/assistant text + compaction summaries, newest kept when over budget. */
export function branchToTranscript(branch: BranchEntry[], maxChars = TRANSCRIPT_MAX_CHARS): string {
  const chunks: string[] = [];
  for (const e of branch) {
    if (e?.type === "compaction" && typeof e.summary === "string") {
      chunks.push(`## Compaction summary\n\n${e.summary}`);
    } else if (
      e?.type === "message" &&
      (e.message?.role === "user" || e.message?.role === "assistant")
    ) {
      const text = textOf(e.message.content);
      if (text) chunks.push(`## ${e.message.role === "user" ? "User" : "Assistant"}\n\n${text}`);
    }
  }
  const all = chunks.join("\n\n");
  return all.length > maxChars ? all.slice(all.length - maxChars) : all;
}

/** File-ish tool-call arguments (path/file keys), deduped, capped. */
export function touchedFiles(branch: BranchEntry[], cap = 50): string[] {
  const files = new Set<string>();
  for (const e of branch) {
    const content =
      e?.type === "message" && e.message?.role === "assistant" ? e.message.content : null;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "toolCall" || !part.arguments || typeof part.arguments !== "object")
        continue;
      for (const [key, value] of Object.entries(part.arguments as Record<string, unknown>)) {
        if (/path|file/i.test(key) && typeof value === "string" && value.length < 400)
          files.add(value);
      }
    }
  }
  return [...files].slice(0, cap);
}

/**
 * Deterministic fallback (§3 step 3): file list + user messages only, in the
 * claim grammar so the page stays homogeneous. Never needs a model.
 */
export function fallbackClaims(branch: BranchEntry[]): Claim[] {
  const asks = branch
    .filter((e) => e?.type === "message" && e.message?.role === "user")
    .map((e) => textOf(e.message?.content).split("\n")[0].slice(0, 200))
    .filter(Boolean)
    .slice(-20);
  const files = touchedFiles(branch);
  const claims: Claim[] = [];
  if (asks.length) {
    claims.push({
      kind: "note",
      heading: "user requests this session (fallback summary)",
      body: asks.map((a) => `- ${a}`).join("\n"),
    });
  }
  if (files.length) {
    claims.push({
      kind: "note",
      heading: "files touched this session (fallback summary)",
      body: files.map((f) => `- \`${f}\``).join("\n"),
    });
  }
  return claims;
}

const EXTRACT_SYSTEM_PROMPT = `You extract durable claims from a coding-agent session transcript.

Output ONLY markdown sections of this exact shape, one claim per section, the heading IS the claim:
## decision: <what was decided>
<one or two lines of why / evidence>

Allowed kinds: decision, fact, open, todo, note.
- decision: a choice that was made and why.
- fact: something verified to be true (measured, tested, observed).
- open: an unresolved question.
- todo: a concrete follow-up action.
- note: anything else a future session must know.

Rules: use absolute dates (YYYY-MM-DD), never relative ones. Never invent anything not in
the transcript. Never write secrets, API keys or passwords. Skip chit-chat; noise is the enemy.
No preamble, no closing remarks, no code fences.`;

export interface ShutdownCaptureInput {
  paths: VaultPaths;
  workspace: string;
  sessionId: string;
  created?: string;
  branch: BranchEntry[];
  complete?: CompleteFn;
  budgetMs: number;
}

/**
 * Freeze one session: model extraction raced against the host budget, else
 * the deterministic fallback. Returns null when the session has nothing to
 * record (no user text, no files). Never loses a non-empty session silently.
 */
export async function captureSession(
  input: ShutdownCaptureInput,
): Promise<SessionPageResult | null> {
  const fallback = fallbackClaims(input.branch);
  if (fallback.length === 0) return null;
  let claims: Claim[] = [];
  if (input.complete) {
    const transcript = branchToTranscript(input.branch);
    try {
      const out = await raceWithTimeout(
        input.complete(EXTRACT_SYSTEM_PROMPT, `SESSION TRANSCRIPT:\n\n${transcript}`),
        input.budgetMs,
        "session summary budget exceeded",
      );
      claims = parseClaims(out);
    } catch {
      claims = [];
    }
  }
  const model = claims.length > 0;
  return writeSessionPage(input.paths, {
    workspace: input.workspace,
    sessionId: input.sessionId,
    created: input.created,
    claims: model ? claims : fallback,
    summaryQuality: model ? "model" : "fallback",
  });
}

/**
 * Wire the exit hook. Registered ONLY when the flag is on (index.ts); the flag
 * is re-read at shutdown so toggling it off mid-session also stops writes.
 * `reload` keeps the session alive, so it never freezes a page (§8.1-3).
 */
export function registerSessionShutdown(
  pi: ExtensionAPI,
  makeComplete: (ctx: ExtensionContext, timeoutMs: number) => CompleteFn,
): void {
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") return;
    try {
      const config = loadTaskConfig(ctx.cwd);
      if (!sessionPagesEnabled(config)) return;
      const paths = resolveSessionVault(ctx.cwd);
      if (!paths || !inspectWritableVault(paths).ok) return;
      const budgetMs =
        detectHost() === "omp"
          ? OMP_SUMMARY_BUDGET_MS
          : (config.sessionPages?.summaryTimeoutSec ?? 120) * 1000;
      await captureSession({
        paths,
        workspace: workspaceSlug(paths, config),
        sessionId: ctx.sessionManager.getSessionId(),
        created: ctx.sessionManager.getHeader()?.timestamp,
        branch: ctx.sessionManager.getBranch() as BranchEntry[],
        complete: ctx.model ? makeComplete(ctx, budgetMs) : undefined,
        budgetMs,
      });
    } catch (err) {
      console.warn(`[llm-wiki] session page skipped: ${(err as Error).message}`);
    }
  });
}

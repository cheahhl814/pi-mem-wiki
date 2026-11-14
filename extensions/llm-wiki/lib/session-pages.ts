import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createKnowledgeDocument, serializeKnowledgeDocument } from "./knowledge-document.js";
import { appendEvent, rebuildMetadataLight } from "./metadata.js";
import type { TaskConfig } from "./task-config.js";
import { getVaultPaths, resolveProjectVaultRoot, slugify, type VaultPaths } from "./utils.js";
import { assertWritableVault } from "./vault-format.js";

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

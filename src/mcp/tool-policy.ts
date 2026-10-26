// Which tools this deployment serves: the per-tool switches.
//
// Three Worker vars set them, all optional:
//
//   - `ENABLE_RISKY_TOOLS`: a comma-separated list. The risky tools below are
//     OFF unless they are named here. So is the `calendar_attendees`
//     capability, without which no calendar write may carry an attendee.
//   - `DISABLED_TOOLS`: a comma-separated list of any tool names to switch off.
//   - `MCP_READ_ONLY`: `true` switches off every tool that writes: every
//     preview, every commit, every draft, and every contact, calendar and rule
//     write.
//
// Off always wins. A tool named in `DISABLED_TOOLS`, or a write while
// `MCP_READ_ONLY` is `true`, stays off even when `ENABLE_RISKY_TOOLS` names it.
//
// **A name this file does not know refuses the whole configuration.** A typo
// in `DISABLED_TOOLS` must never leave a tool on in silence, so the parse
// answers a list of problems instead of a policy, and the door then serves
// nothing until the vars are fixed. The same holds for a value of
// `MCP_READ_ONLY` that is neither `true` nor `false`, and for a tool in
// `ENABLE_RISKY_TOOLS` that is not risky: that one is on already, so naming it
// there shows the list was misread.
//
// **Every tool the server registers has a row in `TOOL_CATALOGUE`.** A tool
// with no row is never registered (`src/mcp/tool-filter.ts`), and
// `test/tool-policy.test.ts` fails until the row is added. So a new tool cannot
// arrive unclassified and on.
//
// This module is pure: it reads no binding itself, opens nothing and awaits
// nothing, so the door can call it on every request without breaking its
// never-awaits contract. It contains no logging calls of any kind and must
// never acquire any.

/** What a tool does to the account, and whether it is off by default. */
interface ToolClass {
  /** It writes: a preview, a commit, a draft, or a change to mail, a contact, an event or a rule. */
  readonly write: boolean;
  /** It is off unless `ENABLE_RISKY_TOOLS` names it. */
  readonly risky: boolean;
}

const READ: ToolClass = Object.freeze({ write: false, risky: false });
const WRITE: ToolClass = Object.freeze({ write: true, risky: false });
const RISKY_WRITE: ToolClass = Object.freeze({ write: true, risky: true });

/**
 * Every tool the server can register, and its class.
 *
 * Three tools are reads although they store something on this server, and none
 * of them changes the iCloud account: `mail_save_attachment` keeps a copy for a
 * five-minute download link, `mail_recall_backfill` fills the person's recall
 * index, and `dav_diagnose` may clear its own discovery cache. The two staging
 * tools are writes, because they exist only to attach a file to a draft.
 */
export const TOOL_CATALOGUE: Readonly<Record<string, ToolClass>> = Object.freeze({
  // Diagnostics.
  mail_imap_diagnose: READ,
  dav_diagnose: READ,
  account_whoami: READ,
  // Mail reads.
  mail_list_folders: READ,
  mail_list_messages: READ,
  mail_list_unread: READ,
  mail_find: READ,
  mail_get_message: READ,
  mail_get_attachment: READ,
  mail_save_attachment: READ,
  mail_recall: READ,
  mail_recall_backfill: READ,
  changes_since: READ,
  // Mail writes.
  mail_compose_new: WRITE,
  mail_compose_reply: WRITE,
  mail_stage_attachment: WRITE,
  mail_confirm_upload: WRITE,
  mail_mark_read: WRITE,
  mail_flag: WRITE,
  mail_move: WRITE,
  mail_archive: WRITE,
  mail_trash: RISKY_WRITE,
  mail_delete_draft: RISKY_WRITE,
  mail_commit: WRITE,
  // Calendar reads.
  calendar_list_calendars: READ,
  calendar_list_events: READ,
  calendar_get_event: READ,
  calendar_search: READ,
  calendar_find_free_slots: READ,
  // Calendar writes.
  calendar_create_calendar: WRITE,
  calendar_update_calendar: WRITE,
  calendar_create_event: WRITE,
  calendar_update_event: WRITE,
  calendar_respond_to_invitation: RISKY_WRITE,
  calendar_delete_event: RISKY_WRITE,
  calendar_delete_calendar: RISKY_WRITE,
  calendar_commit: WRITE,
  // Contacts.
  contacts_search: READ,
  contacts_get: READ,
  contacts_create: WRITE,
  contacts_update: WRITE,
  contacts_commit: WRITE,
  // Rules.
  rules_list: READ,
  rules_test: READ,
  rules_add: WRITE,
  rules_commit: WRITE,
  rules_remove: WRITE,
});

/**
 * The capabilities: switches that are not a tool. Both are risky, so both are
 * off unless `ENABLE_RISKY_TOOLS` names them.
 *
 * `calendar_attendees` lets `calendar_create_event` invite people and lets
 * `calendar_update_event` change an event that has attendees. Both make iCloud
 * email those people, and an invitation cannot be unsent.
 *
 * `mail_unattended_moves` lets the model choose which messages to move with
 * `mail_move` or `mail_archive`, and commit the move, without the user seeing
 * each preview (owner decision, 2026-10-26). A message a stranger wrote can
 * then try to steer where mail is filed. Nothing is removed for good, and while
 * `mail_trash` is off no move may reach the Trash or Junk folder.
 */
export const CAPABILITIES = Object.freeze(["calendar_attendees", "mail_unattended_moves"] as const);

/** One capability name. */
export type Capability = (typeof CAPABILITIES)[number];

/** The risky tools, in catalogue order. */
export const RISKY_TOOLS: readonly string[] = Object.freeze(
  Object.keys(TOOL_CATALOGUE).filter((name) => TOOL_CATALOGUE[name]!.risky),
);

/** The three vars, as the environment holds them. */
export interface ToolSwitches {
  readonly ENABLE_RISKY_TOOLS?: unknown;
  readonly DISABLED_TOOLS?: unknown;
  readonly MCP_READ_ONLY?: unknown;
}

/** What the switches allow. Frozen; built only by `parseToolPolicy`. */
export interface ToolPolicy {
  /** Whether a tool is served. False for any name not in the catalogue. */
  enabled(name: string): boolean;
  /** Whether a capability is on. */
  allows(capability: Capability): boolean;
  /** Whether `MCP_READ_ONLY` is on. */
  readonly readOnly: boolean;
}

/** The parse's answer: a policy, or every problem found, in plain words. */
export type ToolPolicyResult =
  | { readonly ok: true; readonly policy: ToolPolicy }
  | { readonly ok: false; readonly problems: readonly string[] };

function isKnownTool(name: string): boolean {
  return Object.hasOwn(TOOL_CATALOGUE, name);
}

function isCapability(name: string): name is Capability {
  return (CAPABILITIES as readonly string[]).includes(name);
}

/**
 * How an entry is named in a problem. Only a value shaped like a tool name is
 * repeated back. Anything else is described by its length, so a value pasted
 * into the wrong var is never echoed into an answer.
 */
function shown(entry: string): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(entry)
    ? `"${entry}"`
    : `an entry of ${entry.length} characters that is not a tool name`;
}

/**
 * Read one list var: absent or empty is an empty list. A string is split on
 * commas, each entry trimmed, and empty entries dropped, so a trailing comma
 * is fine. An array of strings is accepted too, for a `vars` entry written as
 * JSON. Anything else is a problem.
 */
function readList(
  variable: string,
  value: unknown,
  problems: string[],
): string[] {
  if (value === undefined || value === null) return [];
  let entries: unknown[];
  if (typeof value === "string") entries = value.split(",");
  else if (Array.isArray(value)) entries = value;
  else {
    problems.push(`${variable} must be a comma-separated list of tool names.`);
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      problems.push(`${variable} must hold tool names only.`);
      continue;
    }
    const name = entry.trim();
    if (name.length > 0) names.push(name);
  }
  return names;
}

function readFlag(value: unknown, problems: string[]): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (word === "" || word === "false") return false;
    if (word === "true") return true;
  }
  problems.push('MCP_READ_ONLY must be "true" or "false".');
  return false;
}

/**
 * Parse the three vars. Never throws.
 *
 * Every problem is collected, not only the first, so one fix covers them all.
 */
export function parseToolPolicy(switches: ToolSwitches): ToolPolicyResult {
  const problems: string[] = [];

  const risky = readList("ENABLE_RISKY_TOOLS", switches.ENABLE_RISKY_TOOLS, problems);
  const disabled = readList("DISABLED_TOOLS", switches.DISABLED_TOOLS, problems);
  const readOnly = readFlag(switches.MCP_READ_ONLY, problems);

  for (const name of risky) {
    if (isCapability(name)) continue;
    if (!isKnownTool(name)) {
      problems.push(`ENABLE_RISKY_TOOLS names an unknown tool: ${shown(name)}.`);
    } else if (!TOOL_CATALOGUE[name]!.risky) {
      problems.push(
        `ENABLE_RISKY_TOOLS names "${name}", which is not a risky tool. It is ` +
          "on already unless DISABLED_TOOLS names it. Remove it from " +
          "ENABLE_RISKY_TOOLS.",
      );
    }
  }
  for (const name of disabled) {
    if (!isKnownTool(name) && !isCapability(name)) {
      problems.push(`DISABLED_TOOLS names an unknown tool: ${shown(name)}.`);
    }
  }

  if (problems.length > 0) return { ok: false, problems: Object.freeze(problems) };

  const turnedOn = new Set(risky);
  const turnedOff = new Set(disabled);

  const policy: ToolPolicy = Object.freeze({
    readOnly,
    enabled(name: string): boolean {
      if (!isKnownTool(name)) return false;
      const tool = TOOL_CATALOGUE[name]!;
      if (turnedOff.has(name)) return false;
      if (readOnly && tool.write) return false;
      return !tool.risky || turnedOn.has(name);
    },
    allows(capability: Capability): boolean {
      return !readOnly && !turnedOff.has(capability) && turnedOn.has(capability);
    },
  });
  return { ok: true, policy };
}

/**
 * The policy of a deployment that sets none of the three vars: every risky
 * tool and capability off, everything else on.
 *
 * It is the default wherever a policy is optional, so code built without one
 * fails toward fewer tools, never more.
 */
export const DEFAULT_TOOL_POLICY: ToolPolicy = (() => {
  const parsed = parseToolPolicy({});
  if (!parsed.ok) throw new Error("tool-policy-default-invalid");
  return parsed.policy;
})();

/**
 * The text a misconfigured deployment answers with. It names every problem and
 * where to fix it, and repeats no value that is not shaped like a tool name.
 */
export function misconfigurationMessage(problems: readonly string[]): string {
  return (
    "This server is switched off until its tool switches are fixed. " +
    problems.join(" ") +
    ` Known tools: ${Object.keys(TOOL_CATALOGUE).join(", ")}.` +
    ` Risky tools and capabilities, off unless ENABLE_RISKY_TOOLS names them: ` +
    `${[...RISKY_TOOLS, ...CAPABILITIES].join(", ")}.` +
    " Fix the vars in wrangler.jsonc or in the Cloudflare dashboard."
  );
}

// ------------------------------------------------- what a commit would apply

/**
 * Which preview tool minted a mail confirmation, from its SEALED kind and role.
 * A draft delete is sealed as kind `delete`; a move as kind `move`, with the
 * role the preview resolved: Trash, the archive, or none for a named folder.
 * Null for a seal no mail preview makes.
 */
export function mailPreviewTool(
  kind: string,
  role: "archive" | "trash" | null,
): string | null {
  if (kind === "delete") return "mail_delete_draft";
  if (kind !== "move") return null;
  if (role === "trash") return "mail_trash";
  if (role === "archive") return "mail_archive";
  return "mail_move";
}

/**
 * Which preview tool minted a calendar confirmation. `target` is the sealed
 * arm: a whole calendar (`col`) or one event (`dav`); `kind` is the sealed kind.
 * Null for a seal no calendar preview makes.
 */
export function calendarPreviewTool(target: "dav" | "col", kind: string): string | null {
  if (target === "col") return kind === "delete" ? "calendar_delete_calendar" : null;
  if (kind === "create") return "calendar_create_event";
  if (kind === "update") return "calendar_update_event";
  if (kind === "delete") return "calendar_delete_event";
  if (kind === "reply") return "calendar_respond_to_invitation";
  return null;
}

/** Which preview tool minted a contact confirmation, from its sealed kind. */
export function contactPreviewTool(kind: string): string | null {
  if (kind === "create") return "contacts_create";
  if (kind === "update") return "contacts_update";
  return null;
}

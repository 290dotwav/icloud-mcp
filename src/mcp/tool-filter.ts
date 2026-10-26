// Where the tool switches are enforced, at two levels.
//
// 1. **Registration.** `withToolPolicy` hands back the same server, except
//    that a tool the policy switches off is never registered. So it is absent
//    from `tools/list`, and a `tools/call` naming it is refused by the SDK as
//    an unknown tool. A name with no row in `TOOL_CATALOGUE` is never
//    registered either, so a new tool cannot arrive unclassified and on.
//
// 2. **Commit.** A confirmation is signed and lives five minutes, so one minted
//    before a tool was switched off could still be spent after. Each commit
//    tool therefore reads the SEAL of the confirmation it is handed (which
//    preview minted it, from the signed kind and role) and refuses before
//    anything is spent when that preview tool is now off. The two calendar
//    tools that can reach other people check the `calendar_attendees`
//    capability the same way.
//
// **These checks only ever refuse.** A confirmation they cannot read, or a
// principal that is refused, is passed to the real tool unchanged, which
// refuses it for itself exactly as it always has. Nothing here spends a
// confirmation, opens a session or sends a request: reading a seal is a
// signature check and nothing more.
//
// **The rules job cannot step around either level.** The per-person object
// imports no mail, DAV or tool code (the scan walks its imports), and reaches
// mail only by calling this Worker's own `/mcp` through `SELF`, where the door
// builds the server from this same policy. A tool switched off here is one the
// job cannot call.
//
// This module contains no logging calls of any kind and must never acquire any.

import type { McpServer } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { verifyConfirmation } from "../confirm";
import type { Principal } from "../principal";
import {
  type ToolPolicy,
  TOOL_CATALOGUE,
  calendarPreviewTool,
  contactPreviewTool,
  mailPreviewTool,
} from "./tool-policy";
import type { ToolResult } from "./untrusted";

type Callback = (...args: unknown[]) => unknown;

/** A check run before a tool: a refusal, or null to let the tool run. */
type PreCheck = (args: Record<string, unknown>) => Promise<ToolResult | null>;

/** A refusal: an error answer naming what is switched off. Nothing was changed. */
function refused(refusal: string, tool: string, reason: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ refusal, tool, reason }) }],
  };
}

function toolOff(tool: string): ToolResult {
  return refused(
    "tool-disabled",
    tool,
    `The owner of this server has switched ${tool} off, so a change it ` +
      "previewed cannot be applied. Nothing was changed.",
  );
}

function attendeesOff(tool: string): ToolResult {
  return refused(
    "attendees-disabled",
    tool,
    "The owner of this server has switched calendar invitations off " +
      "(calendar_attendees). An event with attendees makes iCloud email them, " +
      "so nothing was written. Leave the attendees out, or ask the owner to " +
      "add calendar_attendees to ENABLE_RISKY_TOOLS.",
  );
}

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Whether a calendar preview would tell anybody, read off its trusted half.
 * An answer that cannot be read counts as yes: this check fails toward refusing.
 */
function previewNotifies(result: unknown): boolean {
  try {
    const text = (result as ToolResult).content[0]!.text;
    const trusted = JSON.parse(text) as { willNotify?: unknown; recipientCount?: unknown };
    if (trusted.willNotify === false && trusted.recipientCount === 0) return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * The same server, with the policy applied to every tool registered through it.
 *
 * `principal` is the request's own promise, awaited only by the commit checks,
 * and only to read a seal that names its user.
 */
export function withToolPolicy(
  server: McpServer,
  policy: ToolPolicy,
  principal: Promise<Principal>,
): McpServer {
  /** The signed-in user, or null to leave the refusal to the real tool. */
  const userId = async (): Promise<string | null> => {
    try {
      return (await principal).userId;
    } catch {
      return null;
    }
  };

  const preChecks: Record<string, PreCheck> = {
    async mail_commit(args) {
      const user = await userId();
      if (user === null) return null;
      try {
        const seal = await verifyConfirmation(args.confirmToken as string, env.CONFIRM_SECRET, user, "mail");
        const tool = mailPreviewTool(seal.k, seal.qr);
        return tool !== null && !policy.enabled(tool) ? toolOff(tool) : null;
      } catch {
        return null;
      }
    },

    async calendar_commit(args) {
      const user = await userId();
      if (user === null) return null;
      const token = args.confirmToken as string;
      let target: "dav" | "col";
      let kind: string;
      try {
        kind = (await verifyConfirmation(token, env.CONFIRM_SECRET, user, "dav")).k;
        target = "dav";
      } catch {
        try {
          kind = (await verifyConfirmation(token, env.CONFIRM_SECRET, user, "col")).k;
          target = "col";
        } catch {
          return null;
        }
      }
      const tool = calendarPreviewTool(target, kind);
      if (tool !== null && !policy.enabled(tool)) return toolOff(tool);
      // A create is previewed only when it invites somebody. An update carries
      // everyone the stored event would tell. The change is bound to the seal
      // by its hash, so a change altered to drop them is refused by the commit.
      const change = args.change as { attendees?: unknown } | undefined;
      const invites =
        target === "dav" &&
        (kind === "create" || (kind === "update" && hasEntries(change?.attendees)));
      if (invites && !policy.allows("calendar_attendees")) return attendeesOff(tool ?? "calendar_commit");
      return null;
    },

    async contacts_commit(args) {
      const user = await userId();
      if (user === null) return null;
      try {
        const seal = await verifyConfirmation(args.confirmToken as string, env.CONFIRM_SECRET, user, "dav");
        const tool = contactPreviewTool(seal.k);
        return tool !== null && !policy.enabled(tool) ? toolOff(tool) : null;
      } catch {
        return null;
      }
    },

    // Only rules_add mints what rules_commit applies.
    async rules_commit() {
      return policy.enabled("rules_add") ? null : toolOff("rules_add");
    },

    async calendar_create_event(args) {
      return hasEntries(args.attendees) && !policy.allows("calendar_attendees")
        ? attendeesOff("calendar_create_event")
        : null;
    },
  };

  // Checks that need the tool's own answer. The update preview reads the
  // stored event, so only its answer says whether anybody would be told.
  const postChecks: Record<string, (result: unknown) => ToolResult | null> = {
    calendar_update_event(result) {
      if ((result as ToolResult | undefined)?.isError === true) return null;
      return !policy.allows("calendar_attendees") && previewNotifies(result)
        ? attendeesOff("calendar_update_event")
        : null;
    },
  };

  const registerTool = (name: string, config: unknown, callback: Callback): unknown => {
    if (!Object.hasOwn(TOOL_CATALOGUE, name) || !policy.enabled(name)) return undefined;
    const pre = Object.hasOwn(preChecks, name) ? preChecks[name] : undefined;
    const post = Object.hasOwn(postChecks, name) ? postChecks[name] : undefined;
    if (pre === undefined && post === undefined) {
      return server.registerTool(name, config as never, callback as never);
    }
    const gated = async (...args: unknown[]): Promise<unknown> => {
      if (pre !== undefined) {
        const refusal = await pre((args[0] ?? {}) as Record<string, unknown>);
        if (refusal !== null) return refusal;
      }
      const answer = await callback(...args);
      return post === undefined ? answer : (post(answer) ?? answer);
    };
    // Markers another layer put on the callback (the recall step marks the
    // tools it drives) stay on the callback that is registered.
    for (const key of Object.getOwnPropertySymbols(callback)) {
      Object.defineProperty(gated, key, Object.getOwnPropertyDescriptor(callback, key)!);
    }
    return server.registerTool(name, config as never, gated as never);
  };

  return new Proxy(server, {
    get(target, property) {
      if (property === "registerTool") return registerTool;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

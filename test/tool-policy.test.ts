// The per-tool switches: the parse, the catalogue, and the filter on its own.
//
// `src/mcp/tool-policy.ts` turns three Worker vars into a policy, or into a
// list of problems. `src/mcp/tool-filter.ts` applies a policy to a server. This
// file holds both to their claims without a real server or a network:
//
//   1. The risky tools and the calendar_attendees capability are off unless
//      ENABLE_RISKY_TOOLS names them.
//   2. DISABLED_TOOLS switches any tool off, MCP_READ_ONLY switches every write
//      off, and off always wins.
//   3. A name the parse does not know is a problem, never a silent no-op.
//   4. Every tool the registrars register has a catalogue row, so none can
//      arrive unclassified.
//   5. The filter registers nothing that is off and nothing unknown, and the
//      attendee checks refuse before the real tool runs.
//
// test/tool-switches.test.ts drives the same policy through the real factory,
// the real commit tools and the real door.

import { describe, expect, it } from "vitest";
import { registeredNames } from "../scripts/tool-table-core.mjs";
import { withToolPolicy } from "../src/mcp/tool-filter";
import {
  CAPABILITIES,
  DEFAULT_TOOL_POLICY,
  RISKY_TOOLS,
  TOOL_CATALOGUE,
  type ToolPolicy,
  calendarPreviewTool,
  contactPreviewTool,
  mailPreviewTool,
  misconfigurationMessage,
  parseToolPolicy,
} from "../src/mcp/tool-policy";
import { ALL_TOOLS_POLICY } from "./fixtures/all-tools";
import { ownerPrincipal } from "./fixtures/bound-secrets";

// @ts-expect-error -- Vite's `import.meta.glob` has no ambient declaration here.
const TOOL_SOURCES: Record<string, string> = import.meta.glob("../src/mcp/tools/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

const ALL_NAMES = Object.keys(TOOL_CATALOGUE);
const READS = ALL_NAMES.filter((name) => !TOOL_CATALOGUE[name]!.write);
const WRITES = ALL_NAMES.filter((name) => TOOL_CATALOGUE[name]!.write);

/** The policy for these vars. Fails the test if the parse refuses them. */
function policyOf(switches: Parameters<typeof parseToolPolicy>[0]): ToolPolicy {
  const parsed = parseToolPolicy(switches);
  if (!parsed.ok) throw new Error(`refused: ${parsed.problems.join(" | ")}`);
  return parsed.policy;
}

/** The problems for these vars. Fails the test if the parse accepts them. */
function problemsOf(switches: Parameters<typeof parseToolPolicy>[0]): readonly string[] {
  const parsed = parseToolPolicy(switches);
  if (parsed.ok) throw new Error("the parse accepted vars it should refuse");
  return parsed.problems;
}

function enabledNames(policy: ToolPolicy): string[] {
  return ALL_NAMES.filter((name) => policy.enabled(name));
}

describe("the catalogue", () => {
  it("classifies exactly the tools the registrars register", () => {
    const registered = registeredNames(TOOL_SOURCES);
    // Non-vacuity: an empty glob would make both sides empty.
    expect(registered.length).toBeGreaterThan(40);
    expect([...ALL_NAMES].sort()).toEqual([...registered].sort());
  });

  it("names exactly the five risky tools the owner chose", () => {
    expect([...RISKY_TOOLS].sort()).toEqual(
      [
        "calendar_delete_calendar",
        "calendar_delete_event",
        "calendar_respond_to_invitation",
        "mail_delete_draft",
        "mail_trash",
      ].sort(),
    );
    expect([...CAPABILITIES]).toEqual(["calendar_attendees", "mail_unattended_moves"]);
  });

  it("counts every risky tool as a write, so read-only mode switches it off too", () => {
    for (const name of RISKY_TOOLS) expect(TOOL_CATALOGUE[name]!.write, name).toBe(true);
  });

  it("counts every preview and commit as a write", () => {
    for (const name of ALL_NAMES) {
      if (/_commit$|_create|_update|_delete|_add$|_remove$|_move$|_archive$|_trash$|_compose_|_flag$|_mark_read$|_respond_/.test(name)) {
        expect(TOOL_CATALOGUE[name]!.write, name).toBe(true);
      }
    }
  });
});

describe("with no switches set (point 1)", () => {
  it("serves every tool except the risky ones", () => {
    expect(enabledNames(DEFAULT_TOOL_POLICY)).toEqual(
      ALL_NAMES.filter((name) => !RISKY_TOOLS.includes(name)),
    );
    for (const name of RISKY_TOOLS) expect(DEFAULT_TOOL_POLICY.enabled(name), name).toBe(false);
  });

  it("refuses calendar attendees", () => {
    expect(DEFAULT_TOOL_POLICY.allows("calendar_attendees")).toBe(false);
  });

  it("reads empty strings, and an explicit false, as not set", () => {
    const policy = policyOf({ ENABLE_RISKY_TOOLS: "", DISABLED_TOOLS: " , ", MCP_READ_ONLY: "false" });
    expect(enabledNames(policy)).toEqual(enabledNames(DEFAULT_TOOL_POLICY));
    expect(policyOf({ MCP_READ_ONLY: false }).readOnly).toBe(false);
  });

  it("serves no tool that is not in the catalogue", () => {
    expect(DEFAULT_TOOL_POLICY.enabled("mail_send")).toBe(false);
    expect(ALL_TOOLS_POLICY.enabled("mail_send")).toBe(false);
    expect(ALL_TOOLS_POLICY.enabled("constructor")).toBe(false);
  });
});

describe("ENABLE_RISKY_TOOLS (point 1)", () => {
  it("switches on exactly the risky tools it names", () => {
    const policy = policyOf({ ENABLE_RISKY_TOOLS: " mail_trash ,calendar_delete_event, " });
    expect(policy.enabled("mail_trash")).toBe(true);
    expect(policy.enabled("calendar_delete_event")).toBe(true);
    expect(policy.enabled("mail_delete_draft")).toBe(false);
    expect(policy.enabled("calendar_delete_calendar")).toBe(false);
    expect(policy.enabled("calendar_respond_to_invitation")).toBe(false);
    expect(policy.allows("calendar_attendees")).toBe(false);
  });

  it("switches the attendee capability on only when named", () => {
    expect(policyOf({ ENABLE_RISKY_TOOLS: "calendar_attendees" }).allows("calendar_attendees")).toBe(true);
  });

  it("switches unattended moves on only when named, and never in read-only mode", () => {
    expect(DEFAULT_TOOL_POLICY.allows("mail_unattended_moves")).toBe(false);
    expect(policyOf({ ENABLE_RISKY_TOOLS: "mail_unattended_moves" }).allows("mail_unattended_moves")).toBe(true);
    expect(policyOf({ ENABLE_RISKY_TOOLS: "calendar_attendees" }).allows("mail_unattended_moves")).toBe(false);
    expect(
      policyOf({ ENABLE_RISKY_TOOLS: "mail_unattended_moves", MCP_READ_ONLY: "true" }).allows(
        "mail_unattended_moves",
      ),
    ).toBe(false);
  });

  it("accepts a JSON array as well as a comma-separated string", () => {
    const policy = policyOf({ ENABLE_RISKY_TOOLS: ["mail_trash", "calendar_attendees"] });
    expect(policy.enabled("mail_trash")).toBe(true);
    expect(policy.allows("calendar_attendees")).toBe(true);
  });

  it("refuses a tool that is not risky, because it is on already", () => {
    const problems = problemsOf({ ENABLE_RISKY_TOOLS: "mail_find" });
    expect(problems.join(" ")).toContain('"mail_find", which is not a risky tool');
  });
});

describe("DISABLED_TOOLS (point 2)", () => {
  it("switches off any tool it names, and nothing else", () => {
    const policy = policyOf({ DISABLED_TOOLS: "mail_find,contacts_get" });
    expect(policy.enabled("mail_find")).toBe(false);
    expect(policy.enabled("contacts_get")).toBe(false);
    expect(enabledNames(policy)).toEqual(
      enabledNames(DEFAULT_TOOL_POLICY).filter((name) => name !== "mail_find" && name !== "contacts_get"),
    );
  });

  it("wins over ENABLE_RISKY_TOOLS, for a tool and for the capability", () => {
    const policy = policyOf({
      ENABLE_RISKY_TOOLS: "mail_trash,calendar_attendees",
      DISABLED_TOOLS: "mail_trash,calendar_attendees",
    });
    expect(policy.enabled("mail_trash")).toBe(false);
    expect(policy.allows("calendar_attendees")).toBe(false);
  });
});

describe("MCP_READ_ONLY (point 2)", () => {
  it("serves every read and no write", () => {
    const policy = policyOf({ MCP_READ_ONLY: "true" });
    expect(policy.readOnly).toBe(true);
    expect(enabledNames(policy)).toEqual(READS);
    for (const name of WRITES) expect(policy.enabled(name), name).toBe(false);
  });

  it("wins over ENABLE_RISKY_TOOLS", () => {
    const policy = policyOf({
      MCP_READ_ONLY: " TRUE ",
      ENABLE_RISKY_TOOLS: [...RISKY_TOOLS, ...CAPABILITIES].join(","),
    });
    expect(enabledNames(policy)).toEqual(READS);
    expect(policy.allows("calendar_attendees")).toBe(false);
  });

  it("switches off every preview, commit, draft, contact, calendar and rule write", () => {
    const policy = policyOf({ MCP_READ_ONLY: true });
    for (const name of [
      "mail_compose_new", "mail_compose_reply", "mail_stage_attachment", "mail_confirm_upload",
      "mail_mark_read", "mail_flag", "mail_move", "mail_archive", "mail_commit",
      "calendar_create_calendar", "calendar_update_calendar", "calendar_create_event",
      "calendar_update_event", "calendar_commit", "contacts_create", "contacts_update",
      "contacts_commit", "rules_add", "rules_commit", "rules_remove",
    ]) {
      expect(policy.enabled(name), name).toBe(false);
    }
  });
});

describe("a name the parse does not know (point 4)", () => {
  it("refuses a typo in DISABLED_TOOLS, so the tool is never left on in silence", () => {
    const problems = problemsOf({ DISABLED_TOOLS: "mail_find,mail_trahs" });
    expect(problems).toEqual(['DISABLED_TOOLS names an unknown tool: "mail_trahs".']);
  });

  it("refuses a typo in ENABLE_RISKY_TOOLS", () => {
    expect(problemsOf({ ENABLE_RISKY_TOOLS: "calendar_atendees" })).toEqual([
      'ENABLE_RISKY_TOOLS names an unknown tool: "calendar_atendees".',
    ]);
  });

  it("refuses a name that differs only in case", () => {
    expect(problemsOf({ DISABLED_TOOLS: "Mail_Find" }).length).toBe(1);
  });

  it("refuses a read-only value that is neither true nor false", () => {
    expect(problemsOf({ MCP_READ_ONLY: "yes" })).toEqual(['MCP_READ_ONLY must be "true" or "false".']);
    expect(problemsOf({ MCP_READ_ONLY: "ture" }).length).toBe(1);
    expect(problemsOf({ MCP_READ_ONLY: 1 }).length).toBe(1);
  });

  it("refuses a list that is not text", () => {
    expect(problemsOf({ DISABLED_TOOLS: 42 }).length).toBe(1);
    expect(problemsOf({ DISABLED_TOOLS: { mail_find: true } }).length).toBe(1);
    expect(problemsOf({ DISABLED_TOOLS: ["mail_find", 7] }).length).toBe(1);
  });

  it("reports every problem at once", () => {
    const problems = problemsOf({
      ENABLE_RISKY_TOOLS: "nope_one",
      DISABLED_TOOLS: "nope_two",
      MCP_READ_ONLY: "maybe",
    });
    expect(problems.length).toBe(3);
  });

  it("never repeats a value that is not shaped like a tool name", () => {
    const pasted = "Bearer abc def/ghi=jkl";
    const problems = problemsOf({ DISABLED_TOOLS: pasted });
    expect(problems.join(" ")).not.toContain(pasted);
    expect(problems.join(" ")).toContain("an entry of 22 characters that is not a tool name");
    expect(misconfigurationMessage(problems)).not.toContain(pasted);
  });

  it("explains where to fix it", () => {
    const message = misconfigurationMessage(problemsOf({ DISABLED_TOOLS: "mail_trahs" }));
    expect(message).toContain("mail_trahs");
    expect(message).toContain("wrangler.jsonc");
    expect(message).toContain("Cloudflare dashboard");
    expect(message).toContain("mail_trash");
  });
});

describe("which preview tool a seal names (point 3b)", () => {
  it("maps every sealed mail kind and role", () => {
    expect(mailPreviewTool("delete", "trash")).toBe("mail_delete_draft");
    expect(mailPreviewTool("move", "trash")).toBe("mail_trash");
    expect(mailPreviewTool("move", "archive")).toBe("mail_archive");
    expect(mailPreviewTool("move", null)).toBe("mail_move");
    expect(mailPreviewTool("update", null)).toBeNull();
  });

  it("maps every sealed calendar arm and kind", () => {
    expect(calendarPreviewTool("col", "delete")).toBe("calendar_delete_calendar");
    expect(calendarPreviewTool("dav", "delete")).toBe("calendar_delete_event");
    expect(calendarPreviewTool("dav", "create")).toBe("calendar_create_event");
    expect(calendarPreviewTool("dav", "update")).toBe("calendar_update_event");
    expect(calendarPreviewTool("dav", "reply")).toBe("calendar_respond_to_invitation");
    expect(calendarPreviewTool("col", "update")).toBeNull();
  });

  it("maps every sealed contact kind", () => {
    expect(contactPreviewTool("create")).toBe("contacts_create");
    expect(contactPreviewTool("update")).toBe("contacts_update");
    expect(contactPreviewTool("delete")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The filter, over a stand-in server that records what reaches it
// ---------------------------------------------------------------------------

type Registered = Map<string, (...args: unknown[]) => Promise<unknown>>;

/** A stand-in for the SDK server: it records each registration. */
function recordingServer(): { server: never; registered: Registered } {
  const registered: Registered = new Map();
  const server = {
    registerTool(name: string, _config: unknown, callback: (...args: unknown[]) => Promise<unknown>) {
      registered.set(name, callback);
      return { name };
    },
  };
  return { server: server as never, registered };
}

/** A tool answer whose trusted half is this object. */
function answerWith(trusted: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(trusted) }] };
}

function refusalOf(answer: unknown): string | null {
  try {
    const parsed = JSON.parse((answer as { content: { text: string }[] }).content[0]!.text) as {
      refusal?: unknown;
    };
    return typeof parsed.refusal === "string" ? parsed.refusal : null;
  } catch {
    return null;
  }
}

describe("the filter (point 3a)", () => {
  it("registers nothing that is off and nothing it does not know", () => {
    const { server, registered } = recordingServer();
    const filtered = withToolPolicy(server, DEFAULT_TOOL_POLICY, ownerPrincipal());
    const noop = async () => answerWith({});
    for (const name of [...ALL_NAMES, "mail_send"]) filtered.registerTool(name, {} as never, noop as never);

    expect([...registered.keys()]).toEqual(enabledNames(DEFAULT_TOOL_POLICY));
    expect(registered.has("mail_send")).toBe(false);
    for (const name of RISKY_TOOLS) expect(registered.has(name), name).toBe(false);
  });

  it("keeps a marker another layer put on the callback", () => {
    const { server, registered } = recordingServer();
    const marker = Symbol("marker");
    const callback = Object.assign(async () => answerWith({}), { [marker]: true });
    withToolPolicy(server, ALL_TOOLS_POLICY, ownerPrincipal()).registerTool(
      "mail_commit",
      {} as never,
      callback as never,
    );
    expect((registered.get("mail_commit") as unknown as Record<symbol, unknown>)[marker]).toBe(true);
  });
});

describe("the attendee checks (point 1, calendar_attendees)", () => {
  function createEventWith(policy: ToolPolicy): { call: (args: unknown) => Promise<unknown>; ran: () => number } {
    const { server, registered } = recordingServer();
    let runs = 0;
    withToolPolicy(server, policy, ownerPrincipal()).registerTool("calendar_create_event", {} as never, (async () => {
      runs += 1;
      return answerWith({ created: true });
    }) as never);
    return { call: (args) => registered.get("calendar_create_event")!(args, {}), ran: () => runs };
  }

  it("refuses a create with attendees before the tool runs", async () => {
    const tool = createEventWith(DEFAULT_TOOL_POLICY);
    const answer = await tool.call({ attendees: [{ email: "someone@example.invalid" }] });
    expect(refusalOf(answer)).toBe("attendees-disabled");
    expect((answer as { isError?: boolean }).isError).toBe(true);
    expect(tool.ran()).toBe(0);
  });

  it("lets a create with nobody invited through", async () => {
    const tool = createEventWith(DEFAULT_TOOL_POLICY);
    await tool.call({});
    await tool.call({ attendees: [] });
    expect(tool.ran()).toBe(2);
  });

  it("lets a create with attendees through once the capability is on", async () => {
    const tool = createEventWith(policyOf({ ENABLE_RISKY_TOOLS: "calendar_attendees" }));
    const answer = await tool.call({ attendees: [{ email: "someone@example.invalid" }] });
    expect(refusalOf(answer)).toBeNull();
    expect(tool.ran()).toBe(1);
  });

  function updateEventAnswering(policy: ToolPolicy, answer: unknown): Promise<unknown> {
    const { server, registered } = recordingServer();
    withToolPolicy(server, policy, ownerPrincipal()).registerTool(
      "calendar_update_event",
      {} as never,
      (async () => answer) as never,
    );
    return registered.get("calendar_update_event")!({}, {});
  }

  it("refuses an update preview that would tell anybody", async () => {
    const preview = answerWith({ willNotify: true, recipientCount: 3, confirmToken: "t" });
    expect(refusalOf(await updateEventAnswering(DEFAULT_TOOL_POLICY, preview))).toBe("attendees-disabled");
  });

  it("refuses an update preview whose answer it cannot read", async () => {
    const unreadable = { content: [{ type: "text", text: "not json" }] };
    expect(refusalOf(await updateEventAnswering(DEFAULT_TOOL_POLICY, unreadable))).toBe("attendees-disabled");
  });

  it("hands back an update preview that tells nobody, unchanged", async () => {
    const preview = answerWith({ willNotify: false, recipientCount: 0, confirmToken: "t" });
    expect(await updateEventAnswering(DEFAULT_TOOL_POLICY, preview)).toBe(preview);
  });

  it("hands back an error answer unchanged", async () => {
    const error = { isError: true, content: [{ type: "text", text: "{}" }] };
    expect(await updateEventAnswering(DEFAULT_TOOL_POLICY, error)).toBe(error);
  });

  it("hands back a notifying preview once the capability is on", async () => {
    const preview = answerWith({ willNotify: true, recipientCount: 3, confirmToken: "t" });
    expect(await updateEventAnswering(ALL_TOOLS_POLICY, preview)).toBe(preview);
  });
});

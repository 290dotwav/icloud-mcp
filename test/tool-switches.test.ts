// The per-tool switches, driven through the real factory, the real commit tools
// and the real door.
//
// test/tool-policy.test.ts holds the parse and the filter on their own. This
// file holds the three places a switch has to reach in production:
//
//   1. tools/list. A tool that is off is not registered, so a client never
//      sees it, and a tools/call naming it is refused (point 3a).
//   2. The commit tools. A confirmation minted while a preview tool was on is
//      refused once that tool is off, and the refusal spends nothing (point
//      3b). Each refusal has a positive control: with the tool on, the same
//      token reaches the real commit, which then refuses it for its own reason.
//   3. The door. Vars it cannot read switch the whole server off with a
//      message (point 4), and the rules job, which reaches mail only through
//      the door, cannot call a tool that is off (point 3, the agent).
//
// No test here signs in to Apple and none opens a socket: the commit tokens
// are minted with the suite's fake confirmation secret, and every positive
// control is refused by the real commit before any network.

import { McpServer } from "@modelcontextprotocol/server";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { AUTONOMY_TOOLS } from "../src/agent/autonomy-client";
import {
  CONFIRM_TTL_SECONDS,
  CONFIRM_VERSION,
  draftChangeHashOf,
  mailMoveChangeHashOf,
  mintConfirmation,
  reserveConfirmation,
} from "../src/confirm";
import type { Env } from "../src/env";
import { encodeFolderId, encodeMessageId } from "../src/mail/ids";
import { createMcpApiHandler, DEPLOYED_HOSTNAME } from "../src/mcp/api-handler";
import { SERVER_INSTRUCTIONS, UNATTENDED_MOVES_SECTION } from "../src/mcp/instructions";
import { createServerFactory } from "../src/mcp/server";
import {
  DEFAULT_TOOL_POLICY,
  RISKY_TOOLS,
  TOOL_CATALOGUE,
  type ToolPolicy,
  parseToolPolicy,
} from "../src/mcp/tool-policy";
import { ALL_TOOLS_POLICY } from "./fixtures/all-tools";
import { ownerPrincipal } from "./fixtures/bound-secrets";
import { USER_A } from "./fixtures/two-users";

const ORIGIN = `https://${DEPLOYED_HOSTNAME}`;

type Answer = { isError?: boolean; content: { type: "text"; text: string }[] };
type Callback = (args: Record<string, unknown>, extra?: unknown) => Promise<Answer>;

function policyOf(switches: Parameters<typeof parseToolPolicy>[0]): ToolPolicy {
  const parsed = parseToolPolicy(switches);
  if (!parsed.ok) throw new Error(`refused: ${parsed.problems.join(" | ")}`);
  return parsed.policy;
}

/** Every tool the REAL factory registers under this policy, with its callback. */
function realTools(policy: ToolPolicy): Map<string, Callback> {
  const spy = vi.spyOn(McpServer.prototype, "registerTool");
  try {
    createServerFactory(ownerPrincipal(), [], undefined, policy)({ era: "modern" } as never);
    const tools = new Map<string, Callback>();
    for (const [name, , callback] of spy.mock.calls as unknown as [string, unknown, Callback][]) {
      tools.set(name, callback);
    }
    return tools;
  } finally {
    spy.mockRestore();
  }
}

/** The names a client is told about, over a real JSON-RPC exchange. */
async function listedNames(policy: ToolPolicy): Promise<string[]> {
  const answers = await exchange(policy, [{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
  const tools = (answers.get(2)?.result as { tools?: { name: string }[] } | undefined)?.tools;
  expect(tools, "tools/list answered with no tools").toBeDefined();
  return tools!.map((tool) => tool.name).sort();
}

/** Send requests after an initialize, and collect the answers by id. */
async function exchange(
  policy: ToolPolicy,
  requests: JSONRPCMessage[],
): Promise<Map<unknown, Record<string, unknown>>> {
  const server = await createServerFactory(ownerPrincipal(), [], undefined, policy)({ era: "modern" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const received = new Map<unknown, Record<string, unknown>>();
  clientSide.onmessage = (message) => {
    const record = message as unknown as Record<string, unknown>;
    received.set(record.id, record);
  };
  await clientSide.start();
  await server.connect(serverSide);
  await clientSide.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "switches", version: "0" } },
  });
  for (const request of requests) await clientSide.send(request);
  const ids = requests.map((request) => (request as { id: unknown }).id);
  const deadline = Date.now() + 2000;
  while (!ids.every((id) => received.has(id)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await server.close();
  return received;
}

function bodyOf(answer: Answer): Record<string, unknown> {
  return JSON.parse(answer.content[0]!.text) as Record<string, unknown>;
}

const EXPIRY = (): number => Math.floor(Date.now() / 1000) + CONFIRM_TTL_SECONDS;

// ---------------------------------------------------------------------------
// tools/list (point 3a)
// ---------------------------------------------------------------------------

describe("a tool that is off is not registered (point 3a)", () => {
  it("lists no risky tool when no switch is set", async () => {
    const names = await listedNames(DEFAULT_TOOL_POLICY);
    for (const risky of RISKY_TOOLS) expect(names, risky).not.toContain(risky);
    expect(names).toContain("mail_find");
    expect(names).toContain("calendar_commit");
    expect(names.length).toBe(Object.keys(TOOL_CATALOGUE).length - RISKY_TOOLS.length);
  });

  it("lists a risky tool once ENABLE_RISKY_TOOLS names it", async () => {
    const names = await listedNames(policyOf({ ENABLE_RISKY_TOOLS: "mail_trash" }));
    expect(names).toContain("mail_trash");
    expect(names).not.toContain("mail_delete_draft");
  });

  it("drops any tool DISABLED_TOOLS names", async () => {
    const names = await listedNames(policyOf({ DISABLED_TOOLS: "mail_find,rules_add" }));
    expect(names).not.toContain("mail_find");
    expect(names).not.toContain("rules_add");
    expect(names).toContain("mail_list_messages");
  });

  it("lists only reads in read-only mode", async () => {
    const names = await listedNames(policyOf({ MCP_READ_ONLY: "true" }));
    const reads = Object.keys(TOOL_CATALOGUE)
      .filter((name) => !TOOL_CATALOGUE[name]!.write)
      .sort();
    expect(names).toEqual(reads);
  });

  it("refuses a tools/call that names a tool that is off", async () => {
    const answers = await exchange(DEFAULT_TOOL_POLICY, [
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "calendar_delete_event", arguments: { id: "anything" } },
      },
    ]);
    const answer = answers.get(3);
    expect(answer, "the call got no answer").toBeDefined();
    const refused =
      answer!.error !== undefined || (answer!.result as { isError?: boolean } | undefined)?.isError === true;
    expect(refused, "a call to a tool that is off was not refused").toBe(true);
    expect(JSON.stringify(answer)).toContain("calendar_delete_event");
  });
});

// ---------------------------------------------------------------------------
// The commit tools (point 3b)
// ---------------------------------------------------------------------------

const MOVE_IDS = [encodeMessageId({ mailbox: "INBOX", uidValidity: 7, uid: 42 })];

/** A real, unspent mail move confirmation with the given sealed role. */
async function mailMoveToken(role: "trash" | "archive" | null) {
  const userId = (await ownerPrincipal()).userId;
  const change = { op: "move" as const, ids: MOVE_IDS, destination: encodeFolderId({ mailbox: "Target" }) };
  const jti = crypto.randomUUID();
  const expiry = EXPIRY();
  const confirmToken = await mintConfirmation(
    {
      v: CONFIRM_VERSION,
      t: "mail",
      k: "move",
      j: jti,
      m: encodeFolderId({ mailbox: "INBOX" }),
      uv: 7,
      q: encodeFolderId({ mailbox: "Target" }),
      qr: role,
      l: [{ i: 42, z: 1200, d: 1790000000, n: "9001" }],
      h: await mailMoveChangeHashOf(change),
      x: expiry,
      u: userId,
    },
    env.CONFIRM_SECRET,
  );
  return { confirmToken, change, jti, expiry, userId };
}

/** A real, unspent draft-delete confirmation. */
async function draftDeleteToken() {
  const userId = (await ownerPrincipal()).userId;
  const change = {
    op: "draft-delete" as const,
    id: encodeMessageId({ mailbox: "Drafts", uidValidity: 7, uid: 42 }),
    subject: "Thanks",
  };
  const jti = crypto.randomUUID();
  const expiry = EXPIRY();
  const confirmToken = await mintConfirmation(
    {
      v: CONFIRM_VERSION,
      t: "mail",
      k: "delete",
      j: jti,
      m: encodeFolderId({ mailbox: "Drafts" }),
      uv: 7,
      q: encodeFolderId({ mailbox: "Deleted Messages" }),
      qr: "trash",
      l: [{ i: 42, z: 1200, d: 1790000000, n: "9001" }],
      h: await draftChangeHashOf(change),
      x: expiry,
      u: userId,
    },
    env.CONFIRM_SECRET,
  );
  return { confirmToken, change, jti, expiry, userId };
}

/** A real, unspent calendar or contact object confirmation of this kind. */
async function davToken(kind: "create" | "update" | "delete" | "reply") {
  const userId = (await ownerPrincipal()).userId;
  return mintConfirmation(
    {
      v: CONFIRM_VERSION,
      t: "dav",
      k: kind,
      j: crypto.randomUUID(),
      c: "https://dav.example.invalid/home/calendar/",
      o: "https://dav.example.invalid/home/calendar/event.ics",
      r: null,
      e: kind === "create" ? null : '"etag-1"',
      s: null,
      f: [],
      // A hash no change matches, so every positive control below is refused
      // by the real commit at its hash check, before any request is sent.
      h: "no-change-hashes-to-this",
      x: EXPIRY(),
      u: userId,
    },
    env.CONFIRM_SECRET,
  );
}

/** A real, unspent whole-calendar delete confirmation. */
async function collectionDeleteToken() {
  const userId = (await ownerPrincipal()).userId;
  return mintConfirmation(
    {
      v: CONFIRM_VERSION,
      t: "col",
      k: "delete",
      j: crypto.randomUUID(),
      c: "https://dav.example.invalid/home/",
      o: "https://dav.example.invalid/home/calendar/",
      b: "binding",
      g: 0,
      h: "no-change-hashes-to-this",
      x: EXPIRY(),
      u: userId,
    },
    env.CONFIRM_SECRET,
  );
}

async function expectUnspent(jti: string, expiry: number, userId: string): Promise<void> {
  // Claiming the slot now succeeds only if the refusal did not spend it.
  await expect(reserveConfirmation(env.CONFIRM_KV, userId, jti, expiry)).resolves.toBeUndefined();
}

describe("mail_commit refuses a confirmation from a tool that is off (point 3b)", () => {
  it("refuses a draft delete minted before mail_delete_draft was switched off, and spends nothing", async () => {
    const { confirmToken, change, jti, expiry, userId } = await draftDeleteToken();
    const answer = await realTools(DEFAULT_TOOL_POLICY).get("mail_commit")!({ confirmToken, change });
    expect(answer.isError).toBe(true);
    expect(bodyOf(answer)).toMatchObject({ refusal: "tool-disabled", tool: "mail_delete_draft" });
    await expectUnspent(jti, expiry, userId);
  });

  it("refuses a move to Trash while mail_trash is off, and spends nothing", async () => {
    const { confirmToken, change, jti, expiry, userId } = await mailMoveToken("trash");
    const answer = await realTools(DEFAULT_TOOL_POLICY).get("mail_commit")!({ confirmToken, change });
    expect(bodyOf(answer)).toMatchObject({ refusal: "tool-disabled", tool: "mail_trash" });
    await expectUnspent(jti, expiry, userId);
  });

  it("refuses an archive while mail_archive is off", async () => {
    const { confirmToken, change } = await mailMoveToken("archive");
    const answer = await realTools(policyOf({ DISABLED_TOOLS: "mail_archive" })).get("mail_commit")!({
      confirmToken,
      change,
    });
    expect(bodyOf(answer)).toMatchObject({ refusal: "tool-disabled", tool: "mail_archive" });
  });

  it("passes a move to a named folder on to the real commit while mail_move is on", async () => {
    // Altered change: the real commit refuses it at the hash check, before the
    // lease or any socket. What matters is that the filter let it through.
    const { confirmToken, change } = await mailMoveToken(null);
    const altered = { ...change, destination: encodeFolderId({ mailbox: "Elsewhere" }) };
    const answer = await realTools(DEFAULT_TOOL_POLICY).get("mail_commit")!({ confirmToken, change: altered });
    expect(bodyOf(answer).refusal).toBeUndefined();
    expect(bodyOf(answer).category).toBe("confirmation_invalid");
  });

  it("passes the same draft delete on to the real commit once mail_delete_draft is on", async () => {
    const { confirmToken, change } = await draftDeleteToken();
    const altered = { ...change, subject: "Altered" };
    const answer = await realTools(policyOf({ ENABLE_RISKY_TOOLS: "mail_delete_draft" })).get("mail_commit")!({
      confirmToken,
      change: altered,
    });
    expect(bodyOf(answer).refusal).toBeUndefined();
    expect(bodyOf(answer).category).toBe("confirmation_invalid");
  });

  it("is not registered at all in read-only mode", () => {
    expect(realTools(policyOf({ MCP_READ_ONLY: "true" })).has("mail_commit")).toBe(false);
  });
});

describe("calendar_commit refuses a confirmation from a tool that is off (point 3b)", () => {
  const change = (kind: string, attendees: unknown[] = []) => ({ kind, attendees });

  it.each([
    ["delete", "calendar_delete_event"],
    ["reply", "calendar_respond_to_invitation"],
  ] as const)("refuses a sealed %s while %s is off", async (kind, tool) => {
    const confirmToken = await davToken(kind);
    const answer = await realTools(DEFAULT_TOOL_POLICY).get("calendar_commit")!({
      confirmToken,
      change: change(kind),
    });
    expect(bodyOf(answer)).toMatchObject({ refusal: "tool-disabled", tool });
  });

  it("refuses a whole-calendar delete while calendar_delete_calendar is off", async () => {
    const confirmToken = await collectionDeleteToken();
    const answer = await realTools(DEFAULT_TOOL_POLICY).get("calendar_commit")!({
      confirmToken,
      change: change("delete"),
    });
    expect(bodyOf(answer)).toMatchObject({ refusal: "tool-disabled", tool: "calendar_delete_calendar" });
  });

  it("refuses an invitation-carrying create while calendar_attendees is off", async () => {
    const confirmToken = await davToken("create");
    const answer = await realTools(DEFAULT_TOOL_POLICY).get("calendar_commit")!({
      confirmToken,
      change: change("create", [{ email: "someone@example.invalid", name: null }]),
    });
    expect(bodyOf(answer)).toMatchObject({ refusal: "attendees-disabled" });
  });

  it("refuses an update of an event with attendees while calendar_attendees is off", async () => {
    const confirmToken = await davToken("update");
    const answer = await realTools(DEFAULT_TOOL_POLICY).get("calendar_commit")!({
      confirmToken,
      change: change("update", [{ email: "someone@example.invalid", name: null }]),
    });
    expect(bodyOf(answer)).toMatchObject({ refusal: "attendees-disabled" });
  });

  it("refuses an update while calendar_update_event is off", async () => {
    const confirmToken = await davToken("update");
    const answer = await realTools(policyOf({ DISABLED_TOOLS: "calendar_update_event" })).get(
      "calendar_commit",
    )!({ confirmToken, change: change("update") });
    expect(bodyOf(answer)).toMatchObject({ refusal: "tool-disabled", tool: "calendar_update_event" });
  });

  it("passes an update that tells nobody on to the real commit", async () => {
    const confirmToken = await davToken("update");
    const answer = await realTools(DEFAULT_TOOL_POLICY).get("calendar_commit")!({
      confirmToken,
      change: change("update"),
    });
    expect(bodyOf(answer).refusal).toBeUndefined();
    expect(bodyOf(answer).category).toBe("confirmation_invalid");
  });

  it.each([["delete"], ["reply"], ["create"]] as const)(
    "passes a sealed %s on to the real commit once every switch is on",
    async (kind) => {
      const confirmToken = await davToken(kind);
      const answer = await realTools(ALL_TOOLS_POLICY).get("calendar_commit")!({
        confirmToken,
        change: change(kind, kind === "create" ? [{ email: "someone@example.invalid", name: null }] : []),
      });
      expect(bodyOf(answer).refusal).toBeUndefined();
      expect(bodyOf(answer).category).toBe("confirmation_invalid");
    },
  );
});

describe("contacts_commit and rules_commit refuse a confirmation from a tool that is off (point 3b)", () => {
  it("refuses a contact create while contacts_create is off", async () => {
    const confirmToken = await davToken("create");
    const answer = await realTools(policyOf({ DISABLED_TOOLS: "contacts_create" })).get("contacts_commit")!({
      confirmToken,
      change: {},
    });
    expect(bodyOf(answer)).toMatchObject({ refusal: "tool-disabled", tool: "contacts_create" });
  });

  it("refuses a contact update while contacts_update is off", async () => {
    const confirmToken = await davToken("update");
    const answer = await realTools(policyOf({ DISABLED_TOOLS: "contacts_update" })).get("contacts_commit")!({
      confirmToken,
      change: {},
    });
    expect(bodyOf(answer)).toMatchObject({ refusal: "tool-disabled", tool: "contacts_update" });
  });

  it("refuses every rule while rules_add is off", async () => {
    const answer = await realTools(policyOf({ DISABLED_TOOLS: "rules_add" })).get("rules_commit")!({
      confirmToken: "anything",
      rule: {},
    });
    expect(bodyOf(answer)).toMatchObject({ refusal: "tool-disabled", tool: "rules_add" });
  });
});

// ---------------------------------------------------------------------------
// The door (point 4) and the rules job (point 3, the agent)
// ---------------------------------------------------------------------------

const door = createMcpApiHandler();

function rpc(method: string, params: Record<string, unknown>, name?: string): Request {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      host: DEPLOYED_HOSTNAME,
      "Mcp-Method": method,
      ...(name === undefined ? {} : { "Mcp-Name": name }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

/** Drive the real door as user A, with these vars laid over the pool's own. */
async function callDoor(request: Request, vars: Record<string, unknown>): Promise<Response> {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", {
    value: { v: 1, appleId: USER_A.appleId, appPassword: USER_A.appPassword },
    enumerable: true,
  });
  const response = await door.fetch(request, { ...env, ...vars } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** The JSON-RPC message in a door answer. */
function rpcMessage(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Record<string, unknown>;
  const data = trimmed.split("\n").find((line) => line.startsWith("data:"));
  return JSON.parse(data!.slice("data:".length)) as Record<string, unknown>;
}

async function doorToolNames(vars: Record<string, unknown>): Promise<string[]> {
  const response = await callDoor(rpc("tools/list", {}), vars);
  expect(response.status).toBe(200);
  const tools = (rpcMessage(await response.text()).result as { tools: { name: string }[] }).tools;
  return tools.map((tool) => tool.name);
}

describe("the door refuses vars it cannot read (point 4)", () => {
  it.each([
    [{ DISABLED_TOOLS: "mail_trahs" }, "mail_trahs"],
    [{ ENABLE_RISKY_TOOLS: "calendar_delete_events" }, "calendar_delete_events"],
    [{ ENABLE_RISKY_TOOLS: "mail_find" }, "mail_find"],
    [{ MCP_READ_ONLY: "yes" }, "MCP_READ_ONLY"],
  ])("answers 503 with a clear message for %o", async (vars, named) => {
    const response = await callDoor(rpc("tools/list", {}), vars);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; error_description: string };
    expect(body.error).toBe("server_misconfigured");
    expect(body.error_description).toContain(named);
    expect(body.error_description).toContain("switched off until its tool switches are fixed");
  });

  it("serves no tool at all, not even a read, while the vars are wrong", async () => {
    const response = await callDoor(
      rpc("tools/call", { name: "account_whoami", arguments: {} }, "account_whoami"),
      { DISABLED_TOOLS: "mail_find,not_a_tool" },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(USER_A.appleId);
  });

  it("serves the default surface when no switch is set", async () => {
    const names = await doorToolNames({
      ENABLE_RISKY_TOOLS: undefined,
      DISABLED_TOOLS: undefined,
      MCP_READ_ONLY: undefined,
    });
    for (const risky of RISKY_TOOLS) expect(names).not.toContain(risky);
    expect(names).toContain("mail_find");
  });

  it("serves what the vars say", async () => {
    const names = await doorToolNames({ ENABLE_RISKY_TOOLS: "mail_trash", DISABLED_TOOLS: "mail_find" });
    expect(names).toContain("mail_trash");
    expect(names).not.toContain("mail_find");
  });
});

describe("the rules job cannot step around a switch (point 3, the agent)", () => {
  it("names only tools in the catalogue", () => {
    for (const tool of AUTONOMY_TOOLS) expect(Object.hasOwn(TOOL_CATALOGUE, tool), tool).toBe(true);
  });

  it("loses its two actions in read-only mode", () => {
    const policy = policyOf({ MCP_READ_ONLY: "true" });
    expect(policy.enabled("mail_flag")).toBe(false);
    expect(policy.enabled("mail_compose_reply")).toBe(false);
  });

  it("is refused at the door, which is its only way to mail, when it calls a tool that is off", async () => {
    // The job's call is exactly this request: a tools/call to this Worker's
    // own /mcp, through the same door, with a bearer the provider has already
    // checked. Here the door is driven directly with that grant's props.
    for (const vars of [{ MCP_READ_ONLY: "true" }, { DISABLED_TOOLS: "mail_flag" }]) {
      const response = await callDoor(
        rpc("tools/call", { name: "mail_flag", arguments: { id: "x", flagged: true } }, "mail_flag"),
        vars,
      );
      const message = rpcMessage(await response.text());
      // The job reads anything but a tool's own result as a failed call.
      const refused =
        message.error !== undefined || (message.result as { isError?: boolean } | undefined)?.isError === true;
      expect(refused, JSON.stringify(vars)).toBe(true);
      expect(JSON.stringify(message)).toContain("mail_flag");
    }
  });

  // @ts-expect-error -- Vite's `import.meta.glob` has no ambient declaration here.
  const AGENT_SOURCES: Record<string, string> = import.meta.glob("../src/agent/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  });

  it("has no other way to a tool: nothing under src/agent/ imports the MCP layer or registers a tool", () => {
    expect(Object.keys(AGENT_SOURCES).length).toBeGreaterThan(10);
    for (const [path, text] of Object.entries(AGENT_SOURCES)) {
      expect(text, path).not.toMatch(/from\s+"\.\.\/mcp\//);
      expect(text, path).not.toMatch(/registerTool\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// Moves without asking (the mail_unattended_moves capability)
// ---------------------------------------------------------------------------

// @ts-expect-error -- Vite's `import.meta.glob` has no ambient declaration here.
const SERVER_GLOB: Record<string, string> = import.meta.glob("../src/mcp/server.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const SERVER_SOURCE: string = Object.values(SERVER_GLOB)[0] ?? "";

describe("moves without asking are a switch, off by default", () => {
  async function instructionsUnder(policy: ToolPolicy): Promise<unknown> {
    // A tools/list after the initialize, so the exchange waits long enough
    // for the initialize answer too.
    const answers = await exchange(policy, [{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
    return (answers.get(1)?.result as { instructions?: unknown } | undefined)?.instructions;
  }

  async function confirmTokenTextUnder(policy: ToolPolicy): Promise<string> {
    const answers = await exchange(policy, [{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
    const tools = (answers.get(2)?.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    const commit = tools.find((tool) => tool.name === "mail_commit")!;
    return (commit.inputSchema as { properties: { confirmToken: { description: string } } }).properties
      .confirmToken.description;
  }

  it("serves the default instructions, unchanged, when the switch is off", async () => {
    expect(await instructionsUnder(DEFAULT_TOOL_POLICY)).toBe(SERVER_INSTRUCTIONS);
  });

  it("adds the section, and only it, when the switch is on", async () => {
    const policy = policyOf({ ENABLE_RISKY_TOOLS: "mail_unattended_moves" });
    expect(await instructionsUnder(policy)).toBe(SERVER_INSTRUCTIONS + UNATTENDED_MOVES_SECTION);
  });

  it("keeps the section's own fences: existing folders, no Trash or Junk, never a draft", () => {
    expect(UNATTENDED_MOVES_SECTION).toContain("only into folders that already exist");
    expect(UNATTENDED_MOVES_SECTION).toContain("refuses the Trash and Junk folders");
    expect(UNATTENDED_MOVES_SECTION).toContain("Never move a draft");
    expect(UNATTENDED_MOVES_SECTION).toContain("never from what it asks");
  });

  it("tells mail_commit's caller the user must see a move preview unless the switch is on", async () => {
    expect(await confirmTokenTextUnder(DEFAULT_TOOL_POLICY)).toContain(
      "The user must have seen the preview's confirmationLine word for word",
    );
    const relaxed = await confirmTokenTextUnder(policyOf({ ENABLE_RISKY_TOOLS: "mail_unattended_moves" }));
    expect(relaxed).toContain("the user has allowed moves without seeing each preview");
    // Trash and draft previews are still shown to the user.
    expect(relaxed).toContain("For a trash or draft preview, the user must have seen");
  });

  it("wires the Trash and Junk fence to mail_trash, and the description to the capability", () => {
    expect(SERVER_SOURCE).toContain('refuseDisposal: !policy.enabled("mail_trash"),');
    expect(SERVER_SOURCE).toContain('unattendedMoves: policy.allows("mail_unattended_moves"),');
    expect(SERVER_SOURCE).toContain("registerMailTools(server, leasedMail, principal, mailToolOptions);");
  });
});

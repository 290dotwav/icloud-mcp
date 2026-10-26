// The tool policy with every switch on: every risky tool and every capability.
//
// The server factory defaults to the policy of a deployment that sets no
// switch, which serves no risky tool. A test about the WHOLE tool surface (the
// README table, the instructions, the lease and recall classifications) builds
// the factory with this one instead, so it still sees every tool there is.
//
// Built through the real parse, from the real lists, so it cannot name a tool
// the parse would refuse.

import {
  CAPABILITIES,
  RISKY_TOOLS,
  type ToolPolicy,
  parseToolPolicy,
} from "../../src/mcp/tool-policy";

const parsed = parseToolPolicy({
  ENABLE_RISKY_TOOLS: [...RISKY_TOOLS, ...CAPABILITIES].join(","),
});
if (!parsed.ok) throw new Error("all-tools fixture: the parse refused the full list");

/** Every tool on, and calendar invitations allowed. */
export const ALL_TOOLS_POLICY: ToolPolicy = parsed.policy;

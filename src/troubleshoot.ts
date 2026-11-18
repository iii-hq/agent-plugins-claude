/**
 * What to do when the plugin cannot use the engine's mcp-server: one entry
 * per failure, each a one-line fix and the README heading with the full
 * steps. Errors the plugin raises end with `help(key)`, so whoever reads one
 * (a person, or the agent in a session) has the fix and the link.
 */

export const TROUBLESHOOTING_URL = 'https://github.com/iii-hq/agent-plugins-claude';

export const TROUBLESHOOTING = {
  unreachable: {
    anchor: 'mcp-server-is-not-reachable',
    fix: 'Start the iii project (iii compose --up) and check that mcp-server runs, or point the plugin at it with mcp_url.',
  },
  notServing: {
    anchor: 'mcp-server-does-not-answer-at-the-address',
    fix: 'Something answers there, but not mcp-server: check mcp_url, and read the mcp-server log for why it is not serving.',
  },
  origin: {
    anchor: 'mcp-server-refused-the-origin',
    fix: "Add the client's origin to mcp-server's allowed_origins.",
  },
  full: {
    anchor: 'mcp-server-refused-a-new-session',
    fix: 'mcp-server is at its session limit: close other MCP clients, wait for idle sessions to end, or raise max_sessions.',
  },
  websocket: {
    anchor: 'the-address-is-an-engine-websocket-address',
    fix: "Set mcp_url to mcp-server's HTTP address (http://127.0.0.1:3111/mcp by default), not the engine's ws:// address.",
  },
  forbidden: {
    anchor: 'a-call-is-forbidden',
    fix: "rbac-proxy does not let agents call this function: add it to rbac-proxy's expose_functions (or take it out of forbidden_functions), then restart rbac-proxy.",
  },
  toolsMissing: {
    anchor: 'the-iii-tools-are-missing-in-claude-code',
    fix: 'Run /mcp in Claude Code: if the iii server is missing or failed, check the plugin is installed and enabled, and that mcp-server answers at mcp_url.',
  },
  profile: {
    anchor: 'the-default-mcp-profile-did-not-load',
    fix: 'mcp-server answered, but not with the default-mcp profile: check that iii-directory runs on the engine.',
  },
} as const;

export type Trouble = keyof typeof TROUBLESHOOTING;

/** The fix and the link, on one line. */
export function help(key: Trouble): string {
  const { fix, anchor } = TROUBLESHOOTING[key];
  return `Fix: ${fix} See ${TROUBLESHOOTING_URL}#${anchor}`;
}

/** Whether a message already carries a troubleshooting link. */
export function hasHelp(message: string): boolean {
  return message.includes(`${TROUBLESHOOTING_URL}#`);
}

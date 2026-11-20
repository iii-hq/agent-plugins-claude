/**
 * The `iii` agent and the read-only approval hook. Neither is a Claude Code
 * permission mode: those are built in (default, accept edits, plan, auto,
 * bypass) and a plugin cannot add one. The pieces:
 *
 *   - the `iii` agent (`plugins/iii/agents/iii.md`), built from the default-mcp
 *     profile, which a session runs as only with `--agent iii:iii` (it then
 *     replaces Claude Code's system prompt);
 *   - a PreToolUse hook that pre-approves the plugin's read-only tools in
 *     whatever permission mode is active, and
 *   - a PreToolUse hook on `iii_call` that pre-approves only the read-only
 *     directory calls (READ_ONLY_CALLS: listing profiles, reading skills).
 *
 * Any other `iii_call`, and `iii_observe` and `iii_secret_store`, are never
 * pre-approved: they stay with the session's permission mode and, in a
 * headless turn, the worker's allow list and approval gate.
 */

import { TOOL_PREFIX } from './commands.js';

/** `--agent` value: plugin `iii`, agent `iii`. */
export const III_AGENT = 'iii:iii';

export const APPROVED_TOOLS = [
  'iii_status',
  'iii_get_agent',
  'iii_observations_poll',
  'iii_observations_sse',
  'iii_observers',
  'iii_unobserve',
];

/** Calling and observing can do anything on the bus; storing writes the vault. */
export const NEVER_APPROVED_TOOLS = ['iii_call', 'iii_observe', 'iii_secret_store'];

/**
 * What a headless turn may run without a prompt nobody is there to answer:
 * the read-only tools plus calling and observing. rbac-proxy decides what
 * those reach, which is narrower than the `Bash(iii *)` a turn already has.
 * Storing a secret stays with the approval gate.
 */
export const HEADLESS_TOOLS = [...APPROVED_TOOLS, 'iii_call', 'iii_observe'].map(
  (t) => `${TOOL_PREFIX}${t}`,
);

const DECISION = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: 'iii plugin: read-only engine tool',
  },
};

export type HookEntry = { matcher: string; hooks: { type: 'command'; command: string }[] };

/**
 * The `iii_call` function ids that only read profiles and skills from
 * iii-directory. The `iii_call` hook allows exactly these, compared whole.
 */
export const READ_ONLY_CALLS = [
  'directory::agents::list',
  'directory::agents::get',
  'directory::skills::list',
  'directory::skills::get',
] as const;

const CALL_DECISION = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: 'iii plugin: read-only directory call',
  },
} as const;

/**
 * The decision for one `iii_call` PreToolUse input: allow when its
 * `function_id` is one of READ_ONLY_CALLS exactly, else `null` (no decision,
 * so the permission mode decides as for any other call).
 */
export function approveCallDecision(input: unknown): typeof CALL_DECISION | null {
  const hook = input as { tool_name?: unknown; tool_input?: { function_id?: unknown } } | null;
  if (hook?.tool_name !== `${TOOL_PREFIX}iii_call`) return null;
  const id = hook.tool_input?.function_id;
  return typeof id === 'string' && (READ_ONLY_CALLS as readonly string[]).includes(id)
    ? CALL_DECISION
    : null;
}

/** The PreToolUse entry that runs `approve-call` for `iii_call`, and nothing else. */
export function callApprovalHookEntry(): HookEntry {
  return {
    matcher: `^${TOOL_PREFIX}iii_call$`,
    hooks: [
      { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/cli/index.mjs" approve-call' },
    ],
  };
}

/** The PreToolUse entry that allows the read-only tools, and nothing else. */
export function approveHookEntry(): HookEntry {
  return {
    matcher: `^${TOOL_PREFIX}(${APPROVED_TOOLS.join('|')})$`,
    hooks: [{ type: 'command', command: `printf '%s\\n' '${JSON.stringify(DECISION)}'` }],
  };
}

/**
 * The iii tools a headless turn allows. With the approval gate on, calling
 * and observing are left to the gate (an allow rule would skip it).
 */
export function headlessTools(approvalGate: boolean): string[] {
  return approvalGate ? APPROVED_TOOLS.map((t) => `${TOOL_PREFIX}${t}`) : HEADLESS_TOOLS;
}

/**
 * Activity reports: every Claude Code lifecycle event, handed to the
 * claude-code worker's `claude::terminal::activity`, which turns a session's
 * hooks into AgentEvent frames on `claude::on-agent-event`.
 *
 * The claude-code worker (iii-hq/workers) used to write these hooks into its
 * own copy of the plugin; they live here so the worker can install this
 * plugin as published. The event list matches the worker's `HOOK_EVENTS`.
 *
 * A report goes through the `iii` CLI, not mcp-server: the handler is an
 * internal function, and the CLI is what the worker's hooks always used. It
 * is best effort by design. No CLI, no engine, no claude-code worker, a slow
 * engine: the hook gives up within a few seconds, prints nothing and exits 0,
 * so a session never waits on or fails because of a report. Nothing is
 * queued or retried; a standalone `claude` without an engine reports nothing.
 */

import { spawn } from 'node:child_process';

/** The function every report calls. */
export const ACTIVITY_TARGET = 'claude::terminal::activity';

/** The lifecycle events reported, and the hook shape each takes. */
export const ACTIVITY_EVENTS: [event: string, shape: 'plain' | 'matcher'][] = [
  ['SessionStart', 'plain'],
  ['SessionEnd', 'plain'],
  ['UserPromptSubmit', 'plain'],
  ['Stop', 'plain'],
  ['PreToolUse', 'matcher'],
  ['PostToolUse', 'matcher'],
];

// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands it in the hook, not JavaScript
export const ACTIVITY_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/cli/index.mjs" activity';

/** How long the engine has to answer (`iii call --timeout-ms`). */
export const CALL_TIMEOUT_MS = 2_000;
/** When the CLI process is killed, whatever it is doing. */
export const KILL_AFTER_MS = 2_500;
/** How long the hook waits for its input on stdin. */
export const STDIN_TIMEOUT_MS = 1_000;
/**
 * The largest report, in bytes. It travels as one argument, and Linux caps a
 * single argument at 128 KiB; a tool response bigger than this is shortened.
 */
export const MAX_PAYLOAD_BYTES = 100_000;
/** What is kept of a shortened tool response. */
const RESPONSE_PREVIEW_CHARS = 4_000;

/** Runs a program with its output discarded; resolves when it ends or is killed. */
export type Runner = (command: string, args: string[], timeoutMs: number) => Promise<void>;

export type ActivityHookEntry = {
  matcher?: string;
  hooks: { type: 'command'; command: string; timeout: number }[];
};

/** The hooks.json entry for one event: every tool for the tool events. */
export function activityHookEntry(shape: 'plain' | 'matcher'): ActivityHookEntry {
  // `timeout` (seconds) is Claude Code's backstop; the CLI gives up sooner.
  const entry = { hooks: [{ type: 'command' as const, command: ACTIVITY_COMMAND, timeout: 5 }] };
  return shape === 'matcher' ? { matcher: '*', ...entry } : entry;
}

/** The `iii` CLI: `III_CLI` when set, else `iii` on PATH. */
export function iiiCli(env: NodeJS.ProcessEnv): string {
  return env.III_CLI?.trim() || 'iii';
}

/** The hook input as an event object, or null when it is not one. */
export function parseEvent(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The event as JSON within MAX_PAYLOAD_BYTES. Only a tool's input and
 * response grow without bound; they are shortened to a preview, keeping the
 * ids that pair a PreToolUse with its PostToolUse.
 */
export function fitPayload(event: Record<string, unknown>): string {
  const json = JSON.stringify(event);
  if (Buffer.byteLength(json) <= MAX_PAYLOAD_BYTES) return json;
  const fitted: Record<string, unknown> = { ...event };
  for (const key of ['tool_response', 'tool_input'] as const) {
    if (!(key in fitted)) continue;
    const text =
      typeof fitted[key] === 'string' ? (fitted[key] as string) : JSON.stringify(fitted[key]);
    fitted[key] =
      `${text.slice(0, RESPONSE_PREVIEW_CHARS)}… [truncated by the iii plugin: ${text.length} characters]`;
    const next = JSON.stringify(fitted);
    if (Buffer.byteLength(next) <= MAX_PAYLOAD_BYTES) return next;
  }
  // Still too big (a huge prompt, say): report only that the event happened.
  const { hook_event_name, session_id, tool_name, tool_use_id } = event;
  return JSON.stringify({ hook_event_name, session_id, tool_name, tool_use_id });
}

/** The default Runner: no shell, no output, killed after `timeoutMs`. */
export const runQuietly: Runner = (command, args, timeoutMs) =>
  new Promise<void>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('error', done);
    child.once('exit', done);
  });

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

/**
 * The `activity` hook: read the event from stdin and report it. Never throws,
 * never writes to stdout or stderr (a SessionStart hook's stdout would
 * become session context).
 */
export async function reportActivity(
  stdin: (() => Promise<string>) | undefined,
  env: NodeJS.ProcessEnv,
  run: Runner = runQuietly,
): Promise<void> {
  const raw = await withTimeout(stdin?.() ?? Promise.resolve(''), STDIN_TIMEOUT_MS, '');
  const event = parseEvent(raw);
  if (!event) return;
  const args = [
    'call',
    ACTIVITY_TARGET,
    '--json',
    fitPayload(event),
    '--timeout-ms',
    String(CALL_TIMEOUT_MS),
  ];
  await Promise.resolve()
    .then(() => run(iiiCli(env), args, KILL_AFTER_MS))
    .catch(() => undefined);
}

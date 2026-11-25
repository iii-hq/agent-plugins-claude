import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_EVENTS,
  ACTIVITY_TARGET,
  activityHookEntry,
  fitPayload,
  MAX_PAYLOAD_BYTES,
  type Runner,
} from '../src/activity.js';
import { runCli } from '../src/cli.js';
import { approveHookEntry, callApprovalHookEntry } from '../src/mode.js';
import { file, PLUGIN_ROOT } from './_helpers/plugin-files.js';

// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands it in the hook, not JavaScript
const COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/cli/index.mjs" activity';
type Entry = { matcher?: string; hooks: { type: string; command: string }[] };
const hooks = (): Record<string, Entry[]> => JSON.parse(file('hooks/hooks.json')).hooks;

describe('the activity hooks', () => {
  it('report the same lifecycle events the claude-code worker registers', () => {
    expect(ACTIVITY_TARGET).toBe('claude::terminal::activity');
    expect(ACTIVITY_EVENTS).toEqual([
      ['SessionStart', 'plain'],
      ['SessionEnd', 'plain'],
      ['UserPromptSubmit', 'plain'],
      ['Stop', 'plain'],
      ['PreToolUse', 'matcher'],
      ['PostToolUse', 'matcher'],
    ]);
  });

  it('run the plugin CLI once per event, on every tool for the tool events', () => {
    const all = hooks();
    for (const [event, shape] of ACTIVITY_EVENTS) {
      const entries = all[event].filter((e) => e.hooks.some((h) => h.command === COMMAND));
      expect(entries, event).toEqual([activityHookEntry(shape)]);
      expect(entries[0].matcher, event).toBe(shape === 'matcher' ? '*' : undefined);
    }
  });

  it('come after the existing SessionStart and PreToolUse hooks, which keep their order', () => {
    const all = hooks();
    const start = all.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
    expect(start[0]).toBe('node "${CLAUDE_PLUGIN_ROOT}/cli/index.mjs" session-start');
    expect(start[1]).toContain('/cli/index.mjs" sync');
    expect(start.slice(2)).toEqual([COMMAND]);
    expect(all.PreToolUse).toEqual([
      approveHookEntry(),
      callApprovalHookEntry(),
      activityHookEntry('matcher'),
    ]);
  });
});

const EVENT = JSON.stringify({
  hook_event_name: 'UserPromptSubmit',
  session_id: 's1',
  prompt: 'echo $(rm -rf /) "quoted"',
});

function io(env: NodeJS.ProcessEnv, stdin: () => Promise<string>, run?: Runner) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      env,
      fetchFn: (() => {
        throw new Error('activity must not use mcp-server');
      }) as unknown as typeof fetch,
      stdin,
      run,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
    },
  };
}

describe('index.mjs activity', () => {
  it('calls claude::terminal::activity with the hook input through `iii` on PATH, silently', async () => {
    const calls: [string, string[], number][] = [];
    const t = io(
      {},
      async () => EVENT,
      async (cmd, args, ms) => void calls.push([cmd, args, ms]),
    );
    expect(await runCli(['activity'], t.io)).toBe(0);
    expect(calls).toHaveLength(1);
    const [cmd, args, ms] = calls[0];
    expect(cmd).toBe('iii');
    expect(args.slice(0, 3)).toEqual(['call', ACTIVITY_TARGET, '--json']);
    expect(JSON.parse(args[3])).toEqual(JSON.parse(EVENT));
    expect(args.slice(4)).toEqual(['--timeout-ms', '2000']);
    expect(ms).toBeLessThanOrEqual(3000);
    expect(t.out).toEqual([]);
    expect(t.err).toEqual([]);
  });

  it('uses III_CLI when it is set', async () => {
    const calls: string[] = [];
    const t = io(
      { III_CLI: '/opt/iii bin/iii' },
      async () => EVENT,
      async (cmd) => {
        calls.push(cmd);
      },
    );
    expect(await runCli(['activity'], t.io)).toBe(0);
    expect(calls).toEqual(['/opt/iii bin/iii']);
  });

  it('exits 0 silently when the call fails', async () => {
    const t = io(
      {},
      async () => EVENT,
      async () => {
        throw new Error('engine not reachable');
      },
    );
    expect(await runCli(['activity'], t.io)).toBe(0);
    expect(t.out).toEqual([]);
    expect(t.err).toEqual([]);
  });

  it('calls nothing for input that is not a hook event, and never waits on stdin for long', async () => {
    for (const raw of ['', 'not json', '[1]', 'null']) {
      const calls: unknown[] = [];
      const t = io(
        {},
        async () => raw,
        async (...a) => void calls.push(a),
      );
      expect(await runCli(['activity'], t.io), raw).toBe(0);
      expect(calls, raw).toEqual([]);
    }
    const calls: unknown[] = [];
    const started = Date.now();
    const t = io(
      {},
      () => new Promise<string>(() => {}),
      async (...a) => void calls.push(a),
    );
    expect(await runCli(['activity'], t.io)).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls).toEqual([]);
  });

  it('shortens an oversized tool response so the report still fits one argument', () => {
    const big = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_use_id: 't1',
      tool_response: 'x'.repeat(MAX_PAYLOAD_BYTES * 2),
    });
    const fitted = fitPayload(JSON.parse(big));
    expect(Buffer.byteLength(fitted)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const parsed = JSON.parse(fitted);
    expect(parsed).toMatchObject({ hook_event_name: 'PostToolUse', tool_use_id: 't1' });
    expect(parsed.tool_response).toContain('truncated');
    expect(fitPayload(JSON.parse(EVENT))).toBe(EVENT);
  });
});

async function fakeCli(body: string): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'iii-activity-'));
  const path = join(dir, 'iii');
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return { path, dir };
}

/** The committed bundle, run the way Claude Code runs the hook. */
function hook(env: NodeJS.ProcessEnv, input = EVENT) {
  const started = Date.now();
  const result = spawnSync('node', [join(PLUGIN_ROOT, 'cli', 'index.mjs'), 'activity'], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { ...result, elapsed: Date.now() - started };
}

describe('the built hook command', () => {
  it('hands the event to the iii CLI named by III_CLI', async () => {
    const { path, dir } = await fakeCli(`printf '%s\\n' "$@" > "$(dirname "$0")/args"`);
    const r = hook({ III_CLI: path });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const args = (await readFile(join(dir, 'args'), 'utf8')).split('\n');
    expect(args[0]).toBe('call');
    expect(args[1]).toBe(ACTIVITY_TARGET);
    expect(JSON.parse(args[3])).toEqual(JSON.parse(EVENT));
  });

  it('exits 0 quickly and silently when there is no iii CLI', () => {
    const r = hook({ III_CLI: '/nonexistent/iii' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(r.elapsed).toBeLessThan(3000);
  });

  it('exits 0 silently when the CLI fails, as with no engine', async () => {
    const { path } = await fakeCli('echo "connection refused" >&2; exit 1');
    const r = hook({ III_CLI: path });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('gives up on a CLI that hangs, well inside the hook timeout', async () => {
    const { path } = await fakeCli('sleep 30');
    const r = hook({ III_CLI: path });
    expect(r.status).toBe(0);
    expect(r.elapsed).toBeLessThan(5000);
    const entry = hooks().Stop[0] as Entry & { hooks: { timeout?: number }[] };
    expect(entry.hooks[0].timeout).toBeGreaterThanOrEqual(5);
  });
});

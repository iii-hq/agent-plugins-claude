import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { McpClient, normalizeMcpUrl } from '../src/mcp.js';
import { help, TROUBLESHOOTING, TROUBLESHOOTING_URL } from '../src/troubleshoot.js';
import { file } from './_helpers/plugin-files.js';

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

async function readmeAnchors(): Promise<Set<string>> {
  const text = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  return new Set(
    text
      .split('\n')
      .filter((l) => /^#{1,6} /.test(l))
      .map((l) => slug(l.replace(/^#+ /, ''))),
  );
}

function status(code: number, body = ''): typeof fetch {
  return (async () => new Response(body, { status: code })) as typeof fetch;
}

const link = (key: keyof typeof TROUBLESHOOTING) =>
  `${TROUBLESHOOTING_URL}#${TROUBLESHOOTING[key].anchor}`;

describe('troubleshooting links', () => {
  it('every link points at a heading that exists in the README', async () => {
    const anchors = await readmeAnchors();
    expect(anchors.has('troubleshooting')).toBe(true);
    for (const [key, entry] of Object.entries(TROUBLESHOOTING)) {
      expect(anchors.has(entry.anchor), `${key}: #${entry.anchor}`).toBe(true);
    }
  });

  it('help() is one line: the fix, then the link', () => {
    const text = help('unreachable');
    expect(text).not.toContain('\n');
    expect(text).toContain(TROUBLESHOOTING.unreachable.fix);
    expect(text.endsWith(link('unreachable'))).toBe(true);
  });

  it('nothing listening: the fix for an unreachable mcp-server', async () => {
    const refused = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    }) as typeof fetch;
    const err = (await new McpClient('http://127.0.0.1:3111/mcp', refused)
      .callTool('iii_status')
      .catch((e: Error) => e)) as Error;
    expect(err.message).toContain('mcp-server is not reachable');
    expect(err.message).toContain(link('unreachable'));
  });

  it.each([
    [404, 'notServing'],
    [502, 'notServing'],
    [403, 'origin'],
    [503, 'full'],
  ] as const)('HTTP %i links its own fix', async (code, key) => {
    const err = (await new McpClient('http://127.0.0.1:3111/mcp', status(code, 'why'))
      .callTool('iii_status')
      .catch((e: Error) => e)) as Error;
    expect(err.message).toContain(link(key));
    for (const other of Object.keys(TROUBLESHOOTING) as (keyof typeof TROUBLESHOOTING)[]) {
      if (other !== key) expect(err.message).not.toContain(link(other));
    }
  });

  it('the forbidden fix is conditional, keeps intentional refusals, and restarts both', () => {
    const fix = TROUBLESHOOTING.forbidden.fix;
    expect(fix).toMatch(/If agents should call it/);
    // secrets::resolve is forbidden on purpose: never tell anyone to lift it.
    expect(fix).toContain('secrets::resolve');
    // Rules apply to new connections: mcp-server must reconnect too.
    expect(fix).toMatch(/restart rbac-proxy, then mcp-server/i);
  });

  it('an engine WebSocket address links the address fix', () => {
    expect(() => normalizeMcpUrl('ws://127.0.0.1:49134')).toThrow(link('websocket'));
  });

  it('a call rbac-proxy refuses links the forbidden fix; other tool errors do not', async () => {
    const tool = (text: string): typeof fetch =>
      (async (_u: string | URL, init: RequestInit = {}) => {
        const msg = JSON.parse(String(init.body)) as { id?: number; method: string };
        if (msg.id === undefined) return new Response(null, { status: 202 });
        const result =
          msg.method === 'initialize' ? {} : { isError: true, content: [{ type: 'text', text }] };
        return Response.json({ jsonrpc: '2.0', id: msg.id, result });
      }) as typeof fetch;
    const forbidden = (await new McpClient(
      'http://x/mcp',
      tool("FORBIDDEN: function 'orders::delete' not allowed"),
    )
      .callTool('iii_call', { function_id: 'orders::delete' })
      .catch((e: Error) => e)) as Error;
    expect(forbidden.message).toContain(link('forbidden'));
    const other = (await new McpClient('http://x/mcp', tool('no such function'))
      .callTool('iii_call')
      .catch((e: Error) => e)) as Error;
    expect(other.message).not.toContain(TROUBLESHOOTING_URL);
  });

  it('the /iii:* commands send the agent to the troubleshooting guide', async () => {
    for (const path of ['commands/profile.md', 'commands/skills.md']) {
      const text = file(path);
      expect(text, path).toContain(`${TROUBLESHOOTING_URL}#troubleshooting`);
    }
  });
});

describe('the SessionStart hook', () => {
  it('keeps the fix an error carries, and adds the profile fix to any other', async () => {
    const { sessionStartOutput } = await import('../src/session.js');
    const context = (out: string) => JSON.parse(out).hookSpecificOutput.additionalContext as string;
    const carried = context(
      sessionStartOutput({ error: `mcp-server is not reachable. ${help('unreachable')}` }),
    );
    expect(carried).toContain(link('unreachable'));
    expect(carried).not.toContain(link('profile'));
    const bare = context(sessionStartOutput({ error: 'iii_get_agent: no agent default-mcp' }));
    expect(bare).toContain(link('profile'));
    // The agent is told to pass the fix on, not to work around it.
    expect(bare).toMatch(/tell the user/i);
  });
});

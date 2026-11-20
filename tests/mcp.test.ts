import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MCP_URL,
  McpClient,
  McpDirectory,
  normalizeMcpUrl,
  resolveMcpUrl,
} from '../src/mcp.js';

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A fake mcp-server: answers JSON-RPC by method, records every request. */
function fakeServer(
  tools: Record<string, (args: Record<string, unknown>) => { text: string; isError?: boolean }>,
  options: { sse?: boolean; status?: number; refuse?: boolean } = {},
) {
  const sent: Sent[] = [];
  const fetchFn = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ url: String(url), method: init.method ?? 'GET', headers, body });
    if (options.refuse)
      throw new TypeError('fetch failed', {
        cause: new Error('connect ECONNREFUSED 127.0.0.1:3111'),
      });
    if (options.status) return new Response('Not Found', { status: options.status });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    const msg = body as {
      id?: number;
      method: string;
      params?: { name: string; arguments: Record<string, unknown> };
    };
    if (msg.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (msg.method === 'initialize') {
      result = {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-server', version: '0.7.0' },
      };
    } else if (msg.method === 'tools/call') {
      const tool = tools[msg.params?.name ?? ''];
      const out = tool
        ? tool(msg.params?.arguments ?? {})
        : { text: 'unknown tool', isError: true };
      result = {
        content: [{ type: 'text', text: out.text }],
        ...(out.isError ? { isError: true } : {}),
      };
    } else {
      return Response.json({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'method not found' },
      });
    }
    const reply = { jsonrpc: '2.0', id: msg.id, result };
    const extra: Record<string, string> =
      msg.method === 'initialize' ? { 'mcp-session-id': 'sess-1' } : {};
    if (options.sse) {
      return new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, {
        headers: { 'content-type': 'text/event-stream', ...extra },
      });
    }
    return Response.json(reply, { headers: extra });
  };
  return { sent, fetchFn: fetchFn as typeof fetch };
}

describe('resolveMcpUrl', () => {
  it('defaults to the http worker on this machine', () => {
    expect(DEFAULT_MCP_URL).toBe('http://127.0.0.1:3111/mcp');
    expect(resolveMcpUrl([], {})).toEqual({ url: DEFAULT_MCP_URL, source: 'default' });
  });

  it('takes --url, then III_PLUGIN_MCP_URL, then the plugin option', () => {
    const env = {
      III_PLUGIN_MCP_URL: 'http://127.0.0.1:3211/mcp',
      CLAUDE_PLUGIN_OPTION_MCP_URL: 'http://127.0.0.1:3311/mcp',
    };
    expect(resolveMcpUrl(['--url', 'http://h:1/mcp'], env)).toEqual({
      url: 'http://h:1/mcp',
      source: '--url',
    });
    expect(resolveMcpUrl([], env)).toEqual({
      url: 'http://127.0.0.1:3211/mcp',
      source: 'III_PLUGIN_MCP_URL',
    });
    expect(
      resolveMcpUrl([], { CLAUDE_PLUGIN_OPTION_MCP_URL: env.CLAUDE_PLUGIN_OPTION_MCP_URL }),
    ).toEqual({
      url: 'http://127.0.0.1:3311/mcp',
      source: 'plugin option mcp_url',
    });
  });

  it('ignores empty values and an unexpanded user_config placeholder', () => {
    expect(
      resolveMcpUrl([], {
        III_PLUGIN_MCP_URL: ' ',
        CLAUDE_PLUGIN_OPTION_MCP_URL: '${user_config.mcp_url}',
      }),
    ).toEqual({ url: DEFAULT_MCP_URL, source: 'default' });
  });

  it('normalizes shorthand addresses to an http URL ending in /mcp', () => {
    expect(normalizeMcpUrl('3211')).toBe('http://127.0.0.1:3211/mcp');
    expect(normalizeMcpUrl(':3211')).toBe('http://127.0.0.1:3211/mcp');
    expect(normalizeMcpUrl('localhost:3211')).toBe('http://localhost:3211/mcp');
    expect(normalizeMcpUrl('http://127.0.0.1:3211')).toBe('http://127.0.0.1:3211/mcp');
    expect(normalizeMcpUrl('http://127.0.0.1:3211/')).toBe('http://127.0.0.1:3211/mcp');
    expect(normalizeMcpUrl('https://iii.example/team/mcp')).toBe('https://iii.example/team/mcp');
  });

  it('refuses a WebSocket engine address: the plugin talks to mcp-server, not the engine', () => {
    expect(() => normalizeMcpUrl('ws://127.0.0.1:49134')).toThrow(/mcp-server/);
  });
});

describe('McpClient', () => {
  it('initializes once, sends the session id, and calls a tool', async () => {
    const server = fakeServer({
      iii_status: () => ({ text: JSON.stringify({ access_control: 'rbac-proxy' }) }),
    });
    const client = new McpClient('http://127.0.0.1:3211/mcp', server.fetchFn);
    expect(await client.callTool('iii_status')).toEqual({ access_control: 'rbac-proxy' });
    await client.callTool('iii_status');
    const methods = server.sent.map((s) => (s.body as { method?: string })?.method);
    expect(methods).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'tools/call',
    ]);
    expect(server.sent[0].headers['mcp-session-id']).toBeUndefined();
    for (const s of server.sent.slice(1)) expect(s.headers['mcp-session-id']).toBe('sess-1');
    for (const s of server.sent) {
      expect(s.headers.accept).toContain('application/json');
      expect(s.headers.accept).toContain('text/event-stream');
    }
  });

  it('reads answers sent as an SSE stream', async () => {
    const server = fakeServer({ iii_get_skill: () => ({ text: '# kanban' }) }, { sse: true });
    const client = new McpClient('http://x/mcp', server.fetchFn);
    expect(await client.callTool('iii_get_skill', { id: 'kanban' })).toBe('# kanban');
  });

  it('turns a tool error into a thrown error carrying its text', async () => {
    const server = fakeServer({
      iii_get_agent: () => ({ text: 'no such profile: nope', isError: true }),
    });
    const client = new McpClient('http://x/mcp', server.fetchFn);
    await expect(client.callTool('iii_get_agent', { id: 'nope' })).rejects.toThrow(
      'no such profile: nope',
    );
  });

  it('ends its session with DELETE on close, and only when it opened one', async () => {
    const server = fakeServer({ iii_status: () => ({ text: '{}' }) });
    const unused = new McpClient('http://x/mcp', server.fetchFn);
    await unused.close();
    expect(server.sent).toEqual([]);
    const client = new McpClient('http://x/mcp', server.fetchFn);
    await client.callTool('iii_status');
    await client.close();
    const last = server.sent.at(-1);
    expect(last?.method).toBe('DELETE');
    expect(last?.headers['mcp-session-id']).toBe('sess-1');
  });

  it('says mcp-server is not reachable, and how to fix it, when nothing listens', async () => {
    const server = fakeServer({}, { refuse: true });
    const client = new McpClient('http://127.0.0.1:3111/mcp', server.fetchFn);
    const err = await client.callTool('iii_status').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('mcp-server is not reachable at http://127.0.0.1:3111/mcp');
    expect(message).toContain('ECONNREFUSED');
    expect(message).toContain('mcp_url');
    // The fix ends with its troubleshooting entry.
    expect(message).toContain('agent-plugins-claude#mcp-server-is-not-reachable');
  });

  it('says mcp-server is full, not missing, when it refuses a new session', async () => {
    const server = fakeServer({}, { status: 503 });
    const client = new McpClient('http://127.0.0.1:3111/mcp', server.fetchFn);
    const err = (await client.callTool('iii_status').catch((e: Error) => e)) as Error;
    expect(err.message).toContain(
      'mcp-server at http://127.0.0.1:3111/mcp refused a new session (HTTP 503)',
    );
    expect(err.message).not.toContain('no mcp-server answers');
  });

  it('says no mcp-server answers when the URL answers something else', async () => {
    const server = fakeServer({}, { status: 404 });
    const client = new McpClient('http://127.0.0.1:3111/mcp', server.fetchFn);
    await expect(client.callTool('iii_status')).rejects.toThrow(
      /no mcp-server answers at http:\/\/127\.0\.0\.1:3111\/mcp \(HTTP 404\)/,
    );
  });
});

describe('McpDirectory', () => {
  const agents = [
    { id: 'default', description: 'General' },
    { id: 'default-mcp', description: 'For MCP', hidden: true },
  ];
  type Call = { function_id: string; payload: Record<string, unknown>; max_chars?: number };
  /** mcp-server's iii_call: the function's result as compact JSON text. */
  const directoryFunctions: Record<string, (p: Record<string, unknown>) => unknown> = {
    'directory::agents::list': () => ({ agents }),
    'directory::skills::list': (p) => ({ skills: [{ id: 'kanban', search: p.search }] }),
    'directory::skills::get': (p) => ({ id: p.id, title: 'K', body: `# ${String(p.id)}` }),
  };
  function directory(functions = directoryFunctions) {
    const server = fakeServer({
      iii_call: (a) => {
        const c = a as unknown as Call;
        return { text: JSON.stringify(functions[c.function_id]?.(c.payload ?? {}) ?? null) };
      },
      iii_get_agent: (a) => ({ text: JSON.stringify({ id: a.id, system_prompt: 'Be.' }) }),
    });
    const calls = () =>
      server.sent
        .map((s) => (s.body as { params?: { name: string; arguments: unknown } })?.params)
        .filter((p): p is { name: string; arguments: Call } => p?.name === 'iii_call')
        .map((p) => p.arguments);
    return { server, calls, dir: new McpDirectory(new McpClient('http://x/mcp', server.fetchFn)) };
  }

  it('lists profiles with iii_call directory::agents::list, hidden ones only when asked', async () => {
    const { dir, calls } = directory();
    expect((await dir.listAgents(true)).map((a) => a.id)).toEqual(['default', 'default-mcp']);
    expect((await dir.listAgents()).map((a) => a.id)).toEqual(['default']);
    expect(calls()[0]).toMatchObject({ function_id: 'directory::agents::list', payload: {} });
  });

  it('reads a profile with iii_get_agent, without activating it', async () => {
    const { dir, server } = directory();
    expect(await dir.getAgent('writer')).toEqual({ id: 'writer', system_prompt: 'Be.' });
    const call = server.sent.find((s) => (s.body as { method?: string })?.method === 'tools/call');
    expect((call?.body as { params: unknown }).params).toEqual({
      name: 'iii_get_agent',
      arguments: { id: 'writer' },
    });
  });

  it('lists skills with directory::skills::list, passing search and prefix', async () => {
    const { dir, calls } = directory();
    expect(await dir.listSkills({ search: 'kan' })).toEqual([{ id: 'kanban', search: 'kan' }]);
    expect(calls()[0]).toMatchObject({
      function_id: 'directory::skills::list',
      payload: { search: 'kan' },
    });
  });

  it('reads a skill body with directory::skills::get, asking for room for a long one', async () => {
    const { dir, calls } = directory();
    expect(await dir.getSkill('kanban')).toEqual({ id: 'kanban', body: '# kanban' });
    const call = calls()[0];
    expect(call).toMatchObject({
      function_id: 'directory::skills::get',
      payload: { id: 'kanban' },
    });
    expect(call.max_chars).toBeGreaterThanOrEqual(1_000_000);
  });

  it('keeps a skill body that happens to be valid JSON as its text', async () => {
    for (const body of ['{"example":true}', 'null', '42']) {
      const { dir } = directory({ 'directory::skills::get': () => ({ id: 's', body }) });
      expect(await dir.getSkill('s')).toEqual({ id: 's', body });
    }
  });

  it('refuses a reply iii_call cut short instead of using part of it', async () => {
    const server = fakeServer({
      iii_call: () => ({
        text: JSON.stringify({ result: '{"body":"# ka', truncated: true, total_chars: 2_000_001 }),
      }),
    });
    const dir = new McpDirectory(new McpClient('http://x/mcp', server.fetchFn));
    await expect(dir.getSkill('kanban')).rejects.toThrow(/cut|truncated/);
  });

  it('says when a skill has no body', async () => {
    const { dir } = directory({ 'directory::skills::get': () => null });
    await expect(dir.getSkill('missing')).rejects.toThrow(/missing/);
  });

  it('reports the server, its access control and the active profile', async () => {
    const server = fakeServer({
      iii_status: () => ({
        text: JSON.stringify({
          server: 'mcp-server',
          access_control: 'rbac-proxy',
          active_profile: null,
        }),
      }),
    });
    const dir = new McpDirectory(new McpClient('http://x/mcp', server.fetchFn));
    expect(await dir.status()).toEqual({
      server: 'mcp-server',
      access_control: 'rbac-proxy',
      active_profile: null,
    });
  });
});

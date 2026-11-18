import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  profileCommand,
  profileCommandName,
  profileCommands,
  writeProfileCommands,
} from '../src/commands.js';
import { renderSkill, renderSubagent, skillDirectories, slug } from '../src/directory.js';
import { file, PLUGIN_FILES, PLUGIN_ROOT, ROOT } from './_helpers/plugin-files.js';

describe('renderers', () => {
  it('writes a Claude Code subagent with the preloaded skills named', () => {
    const md = renderSubagent({
      id: 'Deep Work',
      description: 'Runs goals.',
      system_prompt: 'Be deep.',
      skills: ['kanban'],
    });
    expect(md).toMatch(
      /^---\nname: iii-deep-work\ndescription: "Runs goals\. \(iii agent profile `Deep Work`\)"\n---/,
    );
    expect(md).toContain('Be deep.');
    expect(md).toContain('`kanban`');
  });

  it('writes a skill file with a slug name', () => {
    expect(slug('kanban/tickets/ticket-worker')).toBe('kanban-tickets-ticket-worker');
    expect(renderSkill({ id: 'a/b', description: 'D', body: 'Body' })).toBe(
      '---\nname: a-b\ndescription: "D"\n---\n\nBody\n',
    );
  });
});

function memoryOps() {
  const disk: Record<string, string> = {};
  const writes: string[] = [];
  const removes: string[] = [];
  return {
    disk,
    writes,
    removes,
    ops: {
      read: async (p: string) => disk[p] ?? null,
      write: async (p: string, c: string) => {
        writes.push(p);
        disk[p] = c;
      },
      remove: async (p: string) => {
        removes.push(p);
        delete disk[p];
      },
    },
  };
}

describe('profile commands', () => {
  it('names a command after the profile, never shadowing /iii:profile or /iii:skills, nor taking `skill`', () => {
    expect(profileCommandName('Deep Work')).toBe('deep-work');
    expect(profileCommandName('profile')).toBe('profile-profile');
    expect(profileCommandName('skill')).toBe('profile-skill');
    expect(profileCommandName('skills')).toBe('profile-skills');
  });

  it('is user-invoked only, so it costs no tokens until used', () => {
    const cmd = profileCommand({ id: 'writer', description: 'Writes.' });
    expect(cmd.path).toBe('commands/writer.md');
    expect(cmd.content).toContain('disable-model-invocation: true');
    expect(cmd.content).toContain('description: "iii profile writer: Writes."');
    expect(cmd.content).toContain('argument-hint: [task]');
    expect(cmd.content).toContain('mcp__plugin_iii_iii__iii_get_agent');
    expect(cmd.content).toContain('$ARGUMENTS');
  });

  it('writes visible profiles, removes gone ones, and touches nothing it did not generate', async () => {
    const m = memoryOps();
    m.disk['/p/commands/profile.md'] = 'static';
    const first = await writeProfileCommands(
      '/p',
      [{ id: 'writer' }, { id: 'deepwork' }, { id: 'helper', hidden: true }],
      m.ops,
    );
    expect(first.written.sort()).toEqual(['commands/deepwork.md', 'commands/writer.md']);
    expect(m.disk['/p/commands/helper.md']).toBeUndefined();

    m.writes.length = 0;
    await writeProfileCommands('/p', [{ id: 'writer' }, { id: 'deepwork' }], m.ops);
    expect(m.writes).toEqual([]);

    const next = await writeProfileCommands('/p', [{ id: 'writer' }], m.ops);
    expect(next.removed).toEqual(['commands/deepwork.md']);
    expect(m.disk['/p/commands/deepwork.md']).toBeUndefined();
    expect(m.disk['/p/commands/profile.md']).toBe('static');
  });

  it('never removes a path outside commands/ even if the manifest names one', async () => {
    const m = memoryOps();
    m.disk['/p/.generated-commands.json'] = JSON.stringify([
      '../../etc/passwd',
      'server/index.mjs',
    ]);
    await writeProfileCommands('/p', [], m.ops);
    expect(m.removes).toEqual([]);
  });
});

describe('the plugin folder', () => {
  it('is one plugin named iii, with no MCP server of its own', () => {
    const paths = PLUGIN_FILES.map((f) => f.path);
    // No MCP server of its own: the plugin uses the mcp-server worker.
    expect(paths.filter((p) => p.startsWith('server/'))).toEqual([]);
    expect(JSON.parse(file('.claude-plugin/plugin.json')).name).toBe('iii');
    // A `commands/skill.md` silently disables every command in the plugin.
    expect(existsSync(join(PLUGIN_ROOT, 'commands', 'skill.md'))).toBe(false);
    // Under the ide worker's common 1 MiB per-file cap (the worker writes
    // these files into sessions through it).
    for (const f of PLUGIN_FILES) expect(Buffer.byteLength(f.content)).toBeLessThan(1024 * 1024);
  });

  it('is listed in the marketplace as iii, from ./plugins/iii, with its own description', () => {
    const market = JSON.parse(
      readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'),
    );
    expect(market.name).toBe('iii');
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0]).toMatchObject({
      name: 'iii',
      source: './plugins/iii',
      description: JSON.parse(file('.claude-plugin/plugin.json')).description,
    });
  });
});

describe('review fixes', () => {
  it('skips profiles whose command name is empty or already taken', () => {
    const files = profileCommands([
      { id: 'Deep Work' },
      { id: 'deep-work' },
      { id: 'a/b' },
      { id: 'a-b' },
      { id: '***' },
    ]);
    expect(files.map((f) => f.path)).toEqual(['commands/deep-work.md', 'commands/a-b.md']);
    // The first profile keeps the name.
    expect(files[0].content).toContain('`Deep Work`');
  });

  it('refuses a skill export whose ids land in one directory', () => {
    expect(skillDirectories(['foo/bar', 'baz'])).toEqual(
      new Map([
        ['foo-bar', 'foo/bar'],
        ['baz', 'baz'],
      ]),
    );
    expect(() => skillDirectories(['foo/bar-baz', 'foo-bar/baz'])).toThrow(
      /foo\/bar-baz.*foo-bar\/baz|foo-bar\/baz.*foo\/bar-baz/,
    );
  });
});

describe('the plugin talks to mcp-server', () => {
  it('declares mcp-server over HTTP at the mcp_url option', () => {
    expect(JSON.parse(file('.mcp.json'))).toEqual({
      mcpServers: { iii: { type: 'http', url: '${user_config.mcp_url}' } },
    });
    const manifest = JSON.parse(file('.claude-plugin/plugin.json'));
    expect(manifest.userConfig.engine_url).toBeUndefined();
    expect(manifest.userConfig.mcp_url).toMatchObject({
      type: 'string',
      default: 'http://127.0.0.1:3111/mcp',
    });
    expect(manifest.userConfig.mcp_url.description).toContain('mcp-server');
  });

  it('ships a small CLI without iii-sdk: every engine call goes through mcp-server', () => {
    const cli = file('cli/index.mjs');
    expect(cli.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(cli)).toBeLessThan(64 * 1024);
    expect(cli).not.toContain('registerWorker');
    expect(cli).not.toContain('iii-sdk');
  });

  it('syncs the profile commands with the CLI at session start', () => {
    const hooks = JSON.parse(file('hooks/hooks.json')).hooks;
    expect(hooks.SessionStart[0].hooks[1].command).toContain('/cli/index.mjs" sync');
  });
});

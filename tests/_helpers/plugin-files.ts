import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The plugin folder a marketplace install copies. */
export const PLUGIN_ROOT = join(ROOT, 'plugins', 'iii');

/** The files that make up the plugin, relative to its root: what the
 * claude-code worker embeds, so every one must exist. */
export const PLUGIN_PATHS = [
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'README.md',
  'agents/iii.md',
  'commands/profile.md',
  'commands/skills.md',
  'hooks/hooks.json',
  'cli/index.mjs',
];

export const PLUGIN_FILES: { path: string; content: string }[] = PLUGIN_PATHS.map((path) => ({
  path,
  content: readFileSync(join(PLUGIN_ROOT, path), 'utf8'),
}));

/** One plugin file's content; throws when it is not part of the plugin. */
export const file = (path: string): string => {
  const f = PLUGIN_FILES.find((x) => x.path === path);
  if (!f) throw new Error(`${path} is not part of the plugin`);
  return f.content;
};

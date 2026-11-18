# iii plugins for Claude Code

The `iii` plugin connects Claude Code to a running [iii](https://github.com/iii-hq) engine.
It adds the engine's MCP tools (`iii_call`, `iii_observe`, profiles and skills), starts every
session on the engine's `default-mcp` agent profile, and gives you `/iii:profile`,
`/iii:skills` and one `/iii:<profile>` command per visible profile. Every call goes through
the engine's [`mcp-server`](https://github.com/iii-hq/workers/tree/main/mcp-server) worker,
so rbac-proxy's rules apply. Details: [plugins/iii/README.md](plugins/iii/README.md).

## Install

In Claude Code:

```
/plugin marketplace add iii-hq/agent-plugins-claude
/plugin install iii@iii
```

From a shell:

```sh
claude plugin marketplace add iii-hq/agent-plugins-claude
claude plugin install iii@iii
```

When mcp-server is not at the default `http://127.0.0.1:3111/mcp`, pass its address:

```sh
claude plugin install iii@iii --config mcp_url=http://127.0.0.1:3211/mcp
```

The plugin needs the engine's `mcp-server` worker running behind rbac-proxy, and Node 22+
for its SessionStart hooks. The `claude-code` worker already carries this plugin; you only
install it for a standalone `claude`.

Update or remove it:

```sh
claude plugin marketplace update iii
claude plugin update iii@iii
claude plugin uninstall iii@iii
```

## Development

```sh
pnpm install
pnpm run build                  # bundle src/ into plugins/iii/cli/index.mjs + BUILD.json
pnpm test                       # vitest
pnpm run lint && pnpm run typecheck
pnpm run check:committed-build  # the committed CLI matches its sources
claude plugin validate . && claude plugin validate plugins/iii
```

`src/` holds the plugin's command line and the modules the `claude-code` worker shares with
it (`commands.ts`, `directory.ts`, `mcp.ts`, `session.ts`, `mode.ts`); the worker fetches
the latest `main` of this repository when it is built.

`plugins/iii/cli/index.mjs` is committed: a marketplace install is a git copy with no build
step. After changing `src/` or `scripts/build.mjs`, run `pnpm run build` and commit both
`cli/index.mjs` and `cli/BUILD.json`; CI fails when they are stale or edited by hand.

## License

Apache-2.0

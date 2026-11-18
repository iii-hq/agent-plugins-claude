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

The plugin needs Node 22+ for its SessionStart hooks, and the engine's `mcp-server` worker
behind rbac-proxy: set that up next. The `claude-code` worker already carries this plugin;
you only install it for a standalone `claude`.

Update or remove it:

```sh
claude plugin marketplace update iii
claude plugin update iii@iii
claude plugin uninstall iii@iii
```

## Set up iii to serve it

The plugin talks to the engine through the `mcp-server` worker, and mcp-server only
starts behind `rbac-proxy`, which decides what agents may call. One-time setup, in your
iii project directory (commands assume the `default` namespace and the engine on its
default port, `ws://127.0.0.1:49134`).

### 1. Add rbac-proxy and the http worker, on this machine only

```sh
iii call compose::add --json '{"workers": ["rbac-proxy", "secrets", {"worker": "http", "config_override": {"host": "127.0.0.1"}}]}'
```

- The http worker listens on every interface (`0.0.0.0`) by default, and mcp-server refuses
  to serve an endpoint other machines can reach. `config_override` binds it to
  `127.0.0.1` and keeps the rest of its settings; compose applies it every time http
  starts. If the project already has http, this updates it and restarts it.
- `secrets` backs the `iii_secret_store` tool.

### 2. Add an auth function

rbac-proxy authenticates every connection by calling a function you provide; without one
it refuses everything. This one accepts a shared token. Run this block in your project
directory: it creates the token in `.env` and the worker in `workers/mcp-auth`, and adds it
to the project.

```sh
token=$(openssl rand -hex 32)
printf 'MCP_TOKEN=%s\nIII_TOKEN=%s\n' "$token" "$token" >> .env

mkdir -p workers/mcp-auth
cat > workers/mcp-auth/index.mjs <<'EOF'
import { timingSafeEqual } from 'node:crypto'
import { registerWorker } from 'iii-sdk'

const iii = registerWorker(process.env.III_URL, { workerName: 'mcp-auth' })
const expected = Buffer.from(process.env.MCP_TOKEN ?? '')

iii.registerFunction(
  'mcp-auth::authenticate',
  async ({ headers = {} }) => {
    const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1]
    const token = Buffer.from(String(auth ?? '').replace(/^Bearer\s+/i, ''))
    if (expected.length < 32 || token.length !== expected.length || !timingSafeEqual(token, expected)) {
      throw new Error('invalid token')
    }
    return {
      allowed_functions: [],
      allow_function_registration: true,
      worker_names: ['mcp-server'],              // mcp-server keeps its own name
      forbidden_functions: ['secrets::resolve'], // agents store secrets, never read them back
    }
  },
  { observable: false }, // it sees tokens: nothing may observe it
)
EOF
(cd workers/mcp-auth && npm init -y >/dev/null && npm i iii-sdk)

iii call compose::add --json '{"workers": [{"worker": "path://./workers/mcp-auth", "env_file": ["./.env"], "scripts": {"run": "node index.mjs"}}]}'
```

`MCP_TOKEN` is what the auth function expects; `III_TOKEN` is what mcp-server sends. They
are the same value.

### 3. Configure rbac-proxy

rbac-proxy's settings live in the configuration worker, under `default-rbac-proxy`:

```sh
iii call configuration::set --json '{
  "id": "default-rbac-proxy",
  "value": {
    "host": "127.0.0.1",
    "port": 49200,
    "engine_url": "ws://127.0.0.1:49134",
    "rbac": {
      "auth_function_id": "mcp-auth::authenticate",
      "expose_endpoints": ["match(\"/\")", "match(\"/ws/channels/*\")", "match(\"/otel\")"],
      "expose_functions": ["match(\"*\")"]
    }
  }
}'
```

- `port` is where mcp-server connects (step 5); `engine_url` is your engine.
- `expose_endpoints`: which engine endpoints rbac-proxy serves. It serves none until you
  list them. `/` is required; `/otel` carries mcp-server's logs and traces; `/ws/channels/*`
  is for functions that stream.
- `expose_functions`: what agents may call. `match("*")` is everything; narrow it to limit
  agents, for example `["match(\"orders::*\")", "match(\"secrets::set\")"]`.

### 4. Restart rbac-proxy

rbac-proxy reads the new settings live, but rule changes only apply to new connections.
Restart it so every connection uses them:

```sh
iii call compose::restart container=rbac-proxy
iii call rbac-proxy::status
```

`rbac-proxy::status` should show `rbac_enabled: true` and the three endpoints.

Do the same after any later change to its settings: `configuration::set`, then
`compose::restart container=rbac-proxy` and `compose::restart container=mcp-server`.

### 5. Add mcp-server

Point it at rbac-proxy's port (not the engine) and give it the token:

```sh
iii call compose::add --json '{"workers": [{"worker": "mcp-server", "env_file": ["./.env"], "environment": {"III_MCP_ENGINE_URL": "ws://127.0.0.1:49200"}}]}'
```

It serves MCP at the http worker's address plus `/mcp`: `http://127.0.0.1:3111/mcp` by
default (`iii call http::status` shows the address). If yours differs, install the plugin
with `--config mcp_url=...` (see Install).

### 6. Check it

Start `claude` and run `/iii:profile`: it shows the active profile (`default-mcp`) and the
profiles on your engine. `/mcp` lists the `iii` server as connected.

If mcp-server does not start, its log says why (`iii call compose::status` shows its state):
usually rbac-proxy is not configured yet (steps 2 to 4) or the http worker is not on
`127.0.0.1` (step 1). Full reference:
[mcp-server](https://github.com/iii-hq/workers/tree/main/mcp-server) and
[rbac-proxy](https://github.com/iii-hq/workers/tree/main/rbac-proxy).

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

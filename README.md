# iii plugins for Claude Code

The `iii` plugin connects Claude Code to a running [iii](https://github.com/iii-hq) engine.
It adds the engine's MCP tools (`iii_call`, `iii_observe`, profiles and skills), starts every
session on the engine's `default-mcp` agent profile, and gives you `/iii:profile`,
`/iii:skills` and one `/iii:<profile>` command per visible profile. Every call goes through
the engine's [`mcp-server`](https://github.com/iii-hq/workers/tree/main/mcp-server) worker,
so rbac-proxy's rules apply. Details: [plugins/iii/README.md](plugins/iii/README.md).

## Set up iii to serve it

**Skip this section** if your project was created by the iii `install.sh` script or from
the harness template: it comes preconfigured, with mcp-server running behind rbac-proxy at
`http://127.0.0.1:3111/mcp`. Go straight to [Install the plugin](#install-the-plugin). To
check, run `iii call compose::status` in the project directory: if it lists `mcp-server`,
the project is already set up.

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
- If your `worker-compose.yaml` already gives http a `config_override` (a custom port, say),
  this command replaces it with just the host. In that case, add `host: 127.0.0.1` to
  your existing `config_override` in `worker-compose.yaml` by hand instead, and add
  `rbac-proxy` and `secrets` on their own.
- `secrets` backs the `iii_secret_store` tool.

### 2. Configure rbac-proxy

rbac-proxy's settings live in the configuration worker, under `default-rbac-proxy`:

```sh
iii call configuration::set --json '{
  "id": "default-rbac-proxy",
  "value": {
    "host": "127.0.0.1",
    "port": 49200,
    "engine_url": "ws://127.0.0.1:49134",
    "rbac": {
      "loopback_auth": {
        "worker_names": ["mcp-server"],
        "forbidden_functions": ["secrets::resolve"]
      },
      "expose_endpoints": ["match(\"/\")", "match(\"/ws/channels/*\")", "match(\"/otel\")"],
      "expose_functions": ["match(\"*\")"]
    }
  }
}'
```

- `loopback_auth` admits connections from this machine only, with no auth function or
  token to set up: every local process can already reach the engine port directly. It
  lets mcp-server keep its own name, and keeps `secrets::resolve` away from agents (it
  would let them read every secret). For an engine others reach over the network, see
  [Remote or shared engines](#remote-or-shared-engines).
- `port` is where mcp-server connects (step 4); `engine_url` is your engine.
- `expose_endpoints`: which engine endpoints rbac-proxy serves. It serves none until you
  list them. `/` is required; `/otel` carries mcp-server's logs and traces; `/ws/channels/*`
  is for functions that stream.
- `expose_functions`: what agents may call. `match("*")` is everything; narrow it to limit
  agents, for example `["match(\"orders::*\")", "match(\"secrets::set\")"]`.

### 3. Restart rbac-proxy

rbac-proxy reads the new settings live, but rule changes only apply to new connections.
Restart it so every connection uses them:

```sh
iii call compose::restart container=rbac-proxy
iii call rbac-proxy::status
```

`rbac-proxy::status` should show `auth: "loopback"` and the three endpoints.

Do the same after any later change to its settings: `configuration::set`, then
`compose::restart container=rbac-proxy` and `compose::restart container=mcp-server`.

### 4. Add mcp-server

Point it at rbac-proxy's port, not the engine's:

```sh
iii call compose::add --json '{"workers": [{"worker": "mcp-server", "environment": {"III_MCP_ENGINE_URL": "ws://127.0.0.1:49200"}}]}'
```

It serves MCP at the http worker's address plus `/mcp`: `http://127.0.0.1:3111/mcp` by
default (`iii call http::status` shows the address). If yours differs, install the plugin
with `--config mcp_url=...` (see [Install the plugin](#install-the-plugin)).

### Remote or shared engines

`loopback_auth` trusts every process on this machine. When other people or machines can
reach rbac-proxy, give it an auth function instead (`rbac.auth_function_id`, which takes
precedence over `loopback_auth`): a function you register that checks each connection,
for example a bearer token, and returns its grants. See
[rbac-proxy](https://github.com/iii-hq/workers/tree/main/rbac-proxy) for the function's
input and answer, and [mcp-server](https://github.com/iii-hq/workers/tree/main/mcp-server)
for sending a token from mcp-server (`III_TOKEN`).

## Install the plugin

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
behind rbac-proxy: [set that up first](#set-up-iii-to-serve-it). The `claude-code` worker already carries this plugin; you only
install it for a standalone `claude`.

Update or remove it:

```sh
claude plugin marketplace update iii
claude plugin update iii@iii
claude plugin uninstall iii@iii
```

## Check it

Start `claude` and run `/iii:profile`: it shows the active profile (`default-mcp`) and the
profiles on your engine. `/mcp` lists the `iii` server as connected.

If mcp-server does not start, its log says why (`iii call compose::status` shows its state):
usually rbac-proxy is not configured yet (steps 2 and 3) or the http worker is not on
`127.0.0.1` (step 1). Full reference:
[mcp-server](https://github.com/iii-hq/workers/tree/main/mcp-server) and
[rbac-proxy](https://github.com/iii-hq/workers/tree/main/rbac-proxy).

## Troubleshooting

Every error from the plugin ends with a one-line fix and a link to one of these entries.
First, check the project is running: `iii call compose::status` in the project directory
lists each worker's state. `iii call compose::logs container=mcp-server` (or
`container=rbac-proxy`) shows a worker's log.

### mcp-server is not reachable

Nothing answers at the plugin's `mcp_url` (default `http://127.0.0.1:3111/mcp`).

1. Start the project: `iii compose --up` in the project directory.
2. Check that `http`, `rbac-proxy` and `mcp-server` are `ready` in `iii call compose::status`.
   If mcp-server is missing, follow [Set up iii to serve it](#set-up-iii-to-serve-it).
3. If mcp-server runs on another address, `iii call http::status` shows the http worker's
   address; install the plugin with that address plus `/mcp`
   (`claude plugin install iii@iii --config mcp_url=...`, see
   [Install the plugin](#install-the-plugin)).

### mcp-server does not answer at the address

The address answers (HTTP 404, 502, ...), but not as mcp-server.

1. Check `mcp_url` ends with mcp-server's `api_path` (`/mcp` by default).
2. Read the mcp-server log. It withdraws `/mcp` and says why when:
   - it is not behind rbac-proxy, or rbac-proxy refuses it: set up steps 2 and 3 of
     [Set up iii to serve it](#set-up-iii-to-serve-it);
   - the http worker listens beyond this machine: bind it to `127.0.0.1` (step 1);
   - it cannot watch the http worker's reloads: allow `http::on-config-change` in
     rbac-proxy's `expose_functions`, then restart rbac-proxy and mcp-server.
3. After a fix, restart mcp-server: `iii call compose::restart container=mcp-server`.

### mcp-server refused the Origin

HTTP 403: the request came with an `Origin` header mcp-server does not allow (browser-based
clients send one; Claude Code does not). Add that origin (for example
`https://app.example.com`) to `allowed_origins` in mcp-server's configuration, then restart
it.

### mcp-server refused a new session

HTTP 503: mcp-server is at its session limit (`max_sessions`, 16 by default).

1. Close other MCP clients you do not need, or wait: idle sessions end after
   `session_idle_ttl_secs` (30 minutes by default).
2. To allow more, raise `max_sessions` in mcp-server's configuration and restart it.

If the 503 says mcp-server runs `interface_only`, its configuration is the one used to
collect its interface, not to serve: remove `interface_only` and restart it.

### The address is an engine WebSocket address

`mcp_url` (or `III_PLUGIN_MCP_URL`, or `--url`) is a `ws://` address: the engine's, not
mcp-server's. Use mcp-server's HTTP address, `http://127.0.0.1:3111/mcp` by default (see
[Install the plugin](#install-the-plugin)).

### A call is forbidden

The error says `FORBIDDEN`: rbac-proxy does not let agents call that function.

1. If agents should call it, add it to rbac-proxy's `expose_functions` (for example
   `match("orders::*")`) and make sure it is not in `forbidden_functions` (step 2 of
   [Set up iii to serve it](#set-up-iii-to-serve-it)).
2. Restart rbac-proxy, then mcp-server, so the rules apply to its connection:
   `iii call compose::restart container=rbac-proxy`, then `container=mcp-server`.

`secrets::resolve` is forbidden on purpose: it would let agents read every secret.

### The iii tools are missing in Claude Code

1. Run `/mcp` in Claude Code. If there is no `iii` server, check the plugin is installed
   and enabled: `claude plugin list` (see [Install the plugin](#install-the-plugin)).
2. If the `iii` server is there but failed, mcp-server is not answering: follow
   [mcp-server is not reachable](#mcp-server-is-not-reachable).
3. After a fix, run `/mcp` and reconnect, or start a new session.

### The default-mcp profile did not load

The session started without the `default-mcp` profile, though mcp-server answered.

1. Check `iii-directory` is `ready` in `iii call compose::status`; it serves the profiles.
2. Check rbac-proxy exposes the profile functions to agents (`expose_functions`), then
   restart rbac-proxy and mcp-server.
3. Start a new Claude Code session.

### Node is missing or too old

The plugin's hooks run `node`: Claude Code shows them failing at session start when Node
is missing or older than 22. Install Node 22 or later and start a new session.

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

## Why a plugin

mcp-server already tells every MCP client how to work with iii: its instructions say
to load the `default-mcp` profile with `iii_get_agent`, to use `iii_call` instead of the
`iii` CLI, and to observe instead of polling. A plain MCP connection works without this
plugin:

```sh
claude mcp add --transport http iii http://127.0.0.1:3111/mcp
```

The plugin adds what instructions cannot:

- **The connection.** It registers the `iii` MCP server at the `mcp_url` option, so there
  is nothing to add by hand.
- **Fewer permission prompts.** Two PreToolUse hooks answer Claude Code's own
  permission check for read-only calls: the read-only tools (`iii_status`,
  `iii_get_agent`, the observation readers), and `iii_call` only when it lists profiles
  or reads skills (`directory::agents::list`, `directory::agents::get`,
  `directory::skills::list`, `directory::skills::get`). Claude Code's allow rules match a
  whole tool, not its arguments, so allowing `iii_call` for those four functions alone
  needs a hook. Every other call still goes through Claude Code's permission dialog and
  your permission mode; the plugin adds no permission UI of its own.
- **The current profile from the first message.** The SessionStart hook loads
  `default-mcp` from the running engine into every session, so a profile changed on the
  engine reaches the next session as it is now, not as a copy written into a prompt.
- **Commands and an agent from your engine.** A background sync writes one
  `/iii:<profile>` command for each profile on your engine, and the `iii` agent
  (`claude --agent iii:iii`) built from `default-mcp`. `/iii:profile` and `/iii:skills`
  browse and switch them.
- **Errors that say how to fix them.** Every error from the plugin ends with a one-line
  fix and a link to the matching [troubleshooting](#troubleshooting) entry.

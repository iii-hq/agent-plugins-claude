# iii: a Claude Code plugin for the iii engine

Agent profiles, skills and the engine itself, as slash commands and MCP
tools. The plugin has no server of its own: its `iii` MCP server is the
engine's [`mcp-server`](https://github.com/iii-hq/workers/tree/main/mcp-server) worker, over HTTP. Every
call therefore goes through `mcp-server`, and so through rbac-proxy's rules.
It works in two places:

- **Inside the `claude-code` worker**, with nothing to install. The worker
  carries this folder in its bundle (the latest of this repository, fetched
  when the worker is built) and installs it wherever Claude Code runs:
  the OS temp dir for headless `claude::run` turns (when `iii_context` is on),
  and `<workspace>/.iii-plugin` on the terminal host for terminal sessions
  (when `setup_workspace` is on). A headless turn's copy lives in a private
  directory of its own (`mkdtemp`, mode 0700), removed when the turn ends.
  The worker points the plugin, and its `default-mcp` SessionStart hook, at
  the engine's mcp-server (the http worker's address plus `/mcp`, or
  `III_PLUGIN_MCP_URL`). When the engine runs no mcp-server, it installs the
  plugin without its MCP server and without default-mcp, so the session works
  through the `iii` CLI as before, and says so. It also adds what only it
  can: the `iii-runtime` skill (only without mcp-server), and the `/iii:<profile>`
  commands, generated fresh for each session. The hooks that report every
  turn onto `claude::on-agent-event` are part of the plugin itself (see
  [Activity reports](#activity-reports)).
- **In a standalone `claude`** on your own machine, from the
  [iii marketplace](https://github.com/iii-hq/agent-plugins-claude):

  ```
  /plugin install iii --marketplace iii-hq/agent-plugins-claude
  ```

  or, from a checkout of that repository,
  `claude --plugin-dir /path/to/agent-plugins-claude/plugins/iii`.

Both need `mcp-server` running on the engine, behind rbac-proxy: see its
README. Without it the `iii` tools are missing, and every `/iii:*` command
says so instead of guessing. The plugin's hooks need Node 22+.

## Connecting to mcp-server

The plugin's `mcp_url` option (Claude Code asks for it when you enable the
plugin) is where mcp-server answers: the http worker's address plus its
`api_path`. The default is `http://127.0.0.1:3111/mcp`. The plugin's CLI
(below) reads `--url`, then `III_PLUGIN_MCP_URL`, then that option.

Ask the agent for `iii_status`: it reports the server, its `access_control`
(`rbac-proxy` and the rules in force) and the session's `active_profile`.

## When something fails

Every error from the plugin ends with a one-line fix and a link to the
[troubleshooting guide](https://github.com/iii-hq/agent-plugins-claude#troubleshooting).

## Commands

Claude Code namespaces plugin commands as `/<plugin>:<command>`, so they all
start with `/iii:` and typing `/iii:` completes them.

| Command | What it does |
| --- | --- |
| `/iii:profile [<profile> [task]]` | Act as any agent profile, hidden ones included. No arguments shows the active profile, then lists them all. |
| `/iii:<profile> [task]` | One per visible profile, e.g. `/iii:writer draft the notes`. |
| `/iii:skills [<skill> [task]]` | Load any skill. No arguments lists them; a non-id word searches. |

Every command is `disable-model-invocation: true`: it is yours to type, and it
adds nothing to a session's context until you do (measured with `/context`).
A profile named `profile`, `skills` or `skill` gets `/iii:profile-<name>`
instead. (A plugin command cannot be named `skill`: Claude Code then loads
none of the plugin's commands.)

Standalone, the `/iii:<profile>` commands come from `sync` (below), which the
plugin's SessionStart hook runs in the background: a profile added to the
engine appears from the next session on.

## The active profile

Every session starts on `default-mcp`: the plugin's SessionStart hook
(`cli/index.mjs session-start`) reads it from mcp-server and adds it to the
session's context. (mcp-server's instructions ask the agent to load it too,
but Claude Code defers MCP tools until they are needed, so a session that
starts on a small question would not.) Loading a profile with `/iii:profile
<id>` or `/iii:<profile>` activates it with `iii_get_agent { activate: true }`.

mcp-server records the active profile per MCP session, and `iii_status`
reports it as `active_profile` (`default-mcp` until another is activated), so
`/iii:profile` shows it even after the conversation was compacted. A renewed
MCP session (mcp-server ends one idle for 30 minutes; each `claude -p` run
is a new one) starts on `default-mcp` again; `/iii:profile` says so when the
conversation follows another profile.

## Tools

The tools are mcp-server's:

| Tool | What it does |
| --- | --- |
| `iii_call` | Call any function by id with a JSON payload. |
| `iii_observe` | Observe a function; each matching invocation becomes an observation. |
| `iii_observations_poll` | Read and remove this session's buffered observations. |
| `iii_observations_sse` | Stream observations on the session's GET stream instead. |
| `iii_observers`, `iii_unobserve` | This session's observers; remove one. |
| `iii_secret_store` | Store a credential in the vault without putting it in a payload. |
| `iii_status` | The server, its access control, and the session's `active_profile`. |
| `iii_get_agent` | Load an agent profile; `activate: true` makes it the session's active one. |

Profiles are listed and skills read with `iii_call`: `directory::agents::list`,
`directory::skills::list` and `directory::skills::get`.

See mcp-server's README for each one in full.

## The iii agent and approvals

Claude Code's permission modes (default, accept edits, plan, auto, bypass)
are built in; a plugin cannot add one. What the plugin adds sits on top of
whichever mode is active:

- **default-mcp, appended.** Every session gets the `default-mcp` profile in
  addition to Claude Code's own system prompt, never in place of it.
  Standalone, the SessionStart hook (`cli/index.mjs session-start`) adds it.
  In the worker, headless turns append it to the system prompt and terminal
  sessions get `--append-system-prompt-file <plugin>/default-mcp.md` (an
  `--append-system-prompt` in the terminal args wins, and the worker says so).
- **The `iii` agent** (`agents/iii.md`), for `claude --agent iii:iii`. Its
  body is the `default-mcp` prompt: the worker writes it when it installs
  the plugin, and standalone `sync` rewrites it at session start, so there is
  no hand-written copy. Until the first sync, the committed file only says
  to load `default-mcp`. An agent replaces Claude Code's system prompt, so
  the worker never starts sessions with it; it is there for people who want
  that.
- **Read-only tools are pre-approved** by a PreToolUse hook: `iii_status`,
  `iii_get_agent`, `iii_observations_poll`, `iii_observations_sse`,
  `iii_observers`, `iii_unobserve`.
- **Read-only directory calls are pre-approved** by a second hook on
  `iii_call`: it allows a call only when its `function_id` is exactly
  `directory::agents::list`, `directory::agents::get`,
  `directory::skills::list` or `directory::skills::get`, so listing profiles
  and reading skills never prompt. Every other `iii_call`, and `iii_observe`
  and `iii_secret_store`, stays with the permission mode in interactive
  sessions. Headless
  worker turns, which no one is there to prompt, also allow `iii_call` and
  `iii_observe`: rbac-proxy bounds what they reach, which is narrower than
  the `Bash(iii *)` a turn already has. With the worker's `approval_gate` on,
  those two go through the gate instead, and `iii_secret_store` always does.

Every `/iii:*` command carries the same rule: `iii_call` instead of the `iii`
CLI, `iii_observe` instead of polling, and `agent_call` / `harness::observe`
in harness-written profiles mean `iii_call` / `iii_observe` here.

## Activity reports

The plugin reports what a session does to the engine, so the console can
show a Claude Code session's turns like any other agent's. On six Claude
Code events (session start and end, each prompt, each tool call before and
after it runs, and when Claude stops) a hook runs
`node "${CLAUDE_PLUGIN_ROOT}/cli/index.mjs" activity`. It passes the event
Claude Code gave the hook, unchanged, to the claude-code worker's
`claude::terminal::activity` function, through the `iii` CLI: the one named
by the `III_CLI` environment variable, or `iii` on your PATH. A very large
tool input or result is cut to a short preview first.

A report never gets in the session's way. The hook prints nothing, always
exits successfully, and gives up after about two and a half seconds. When
there is no `iii` CLI, no engine running, or no claude-code worker on it,
the report is simply dropped: nothing is queued or retried. So in a
standalone `claude` the reports only reach anything while an engine with
the claude-code worker is running; the worker shows that session on
`claude::on-agent-event` under a name of its own (`claude-<id>-<time>`),
the same way it shows the terminals it starts. These hooks run alongside
the SessionStart and approval hooks above and never change their answers.

## CLI

```sh
node plugins/iii/cli/index.mjs status   # which mcp-server, and what it reports
node plugins/iii/cli/index.mjs sync     # regenerate /iii:<profile> commands and the iii agent now
node plugins/iii/cli/index.mjs export   # profiles as native ~/.claude/agents/iii-<id>.md
node plugins/iii/cli/index.mjs export --skills --target ./.claude --include-hidden
node plugins/iii/cli/index.mjs session-start  # what the default-mcp hook adds
echo '{"hook_event_name":"Stop","session_id":"test"}' | node plugins/iii/cli/index.mjs activity  # one activity report
```

Each takes `--url <mcp-url>`. `export` is a snapshot for people who want the
profiles in `/agents` without the plugin; re-run it to refresh. Profile models
are not copied (iii profiles name models across providers).

## Building and the committed CLI

`cli/index.mjs` is a build output, and it is **committed**: a plugin installed
from git (a Claude Code marketplace) is a copy of this folder with no build
step of its own. It has no dependencies (plain `fetch` to mcp-server), so it
is a few kilobytes. Its source is `src/` at the root of
[iii-hq/agent-plugins-claude](https://github.com/iii-hq/agent-plugins-claude).

After changing anything under `src/`, the lockfile, or the build script,
rebuild and commit both files:

```sh
pnpm run build   # writes cli/index.mjs and cli/BUILD.json
```

`cli/BUILD.json` records a hash of every input the bundle was built from and
of the output. CI runs `pnpm run check:committed-build`, which fails when an
input changed without a rebuild, or when `cli/index.mjs` was edited by hand.
Generated `/iii:<profile>` commands are git-ignored.

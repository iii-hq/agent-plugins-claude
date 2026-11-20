---
description: Load an iii skill from the running engine (no arguments lists them)
argument-hint: <skill> [task]
disable-model-invocation: true
allowed-tools: mcp__plugin_iii_iii__iii_status
---

Arguments: `$ARGUMENTS`

Skills live in the running iii engine and are read through the iii plugin's
`iii` MCP server (the engine's `mcp-server` worker). Never answer from
memory.

Skills are read with `iii_call`: `directory::skills::list` (payload `{}`,
`{ "search": "..." }` or `{ "prefix": "..." }`) and `directory::skills::get`
(payload `{ "id": "<skill>" }`); the iii plugin approves these reads itself.

**No arguments:** list the skills and show the skill ids grouped by
their first path segment (`kanban/...`, `harness/...`), one compact line per
group. Then say: run `/iii:skills <skill> [task]`. Stop.

**With a single word that is not an exact id** (e.g. `kanban tickets`), call
`directory::skills::list` with it as `search` and pick the closest id; if several fit
equally, list them and stop.

**Otherwise** the first word is a skill id and the rest, if any, is the task.

1. Read it with `directory::skills::get` and that id.
2. Follow the skill for the rest of this conversation. Confirm in one line
   which skill is loaded.
3. If a task was given, start it now. Otherwise wait for the next message.

If the `iii` MCP tools are missing, cannot connect, or a call fails, stop and
tell the user what failed, quoting the error. (The iii plugin reaches the
engine through the `mcp-server` worker at its `mcp_url` option, default
`http://127.0.0.1:3111/mcp`.) An error from the iii plugin
ends with its fix and a link: pass both on. Otherwise point to the matching
entry in the troubleshooting guide,
https://github.com/iii-hq/agent-plugins-claude#troubleshooting (for example
"The iii tools are missing in Claude Code" or "A call is forbidden"). Do not
work around it with the `iii` CLI.

While you work, act on the engine with `iii_call` (any function id, with a
payload) instead of the `iii` CLI, and react to it with `iii_observe` (then
`iii_observations_poll`, and `iii_unobserve` when done) instead of polling.
Where a profile or skill says `agent_call` or `harness::observe`, use
`iii_call` and `iii_observe`.

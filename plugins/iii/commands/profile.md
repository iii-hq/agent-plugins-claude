---
description: Act as an iii agent profile from the running engine (no arguments shows the active one and lists them)
argument-hint: <profile> [task]
disable-model-invocation: true
allowed-tools: mcp__plugin_iii_iii__iii_get_agent, mcp__plugin_iii_iii__iii_status
---

Arguments: `$ARGUMENTS`

Agent profiles live in the running iii engine and are read through the iii
plugin's `iii` MCP server (the engine's `mcp-server` worker). Never answer
from memory.

**No arguments:** call `iii_status` and read its `active_profile`: the
profile this session follows (`default-mcp`, loaded at session start, until
another is loaded). Start with one line, `Active profile: <id>`. If you
loaded a different profile earlier in this conversation and
`active_profile` does not name it, the MCP session was renewed since
(mcp-server ends a session idle for 30 minutes, and every `claude -p` run is
a new one): name the profile you follow, and say `/iii:profile <id>` makes it
active again. Then call
`iii_call` with `directory::agents::list` (payload `{}`) and show each profile as one
line: its `id` and its description shortened to a sentence, the active one
marked active, hidden ones last and marked hidden. Then say: run
`/iii:profile <profile> [task]`, or `/iii:<profile>` for a visible one. Stop.

**Otherwise** the first word is a profile id and the rest, if any, is the task.

1. Call `iii_get_agent` with that id and `activate: true`, so it becomes the
   session's active profile. If there is no such profile, list them with
   `iii_call` (`directory::agents::list`), name the closest ids, and stop.
2. Read every id in the profile's `skills` with `iii_call`
   (`directory::skills::get`, payload `{ "id": "<skill>" }`).
3. From now on, for the rest of this conversation, follow the profile's
   `system_prompt` as your instructions, on top of these session rules.
   Confirm in one line which profile is active.
4. If a task was given, start it as that profile now. Otherwise wait for the
   next message.

If the `iii` MCP tools are missing, cannot connect, or a call fails, stop and
tell the user what failed, quoting the error. (The iii plugin reaches the
engine through the `mcp-server` worker at `III_MCP_URL`, default
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

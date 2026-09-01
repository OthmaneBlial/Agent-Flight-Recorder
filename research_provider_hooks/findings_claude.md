# Claude Code hooks: official contract draft

Verified 2026-09-01 against Anthropic's current official documentation. Primary source: [Hooks reference](https://code.claude.com/docs/en/hooks). Supporting official pages: [hooks guide](https://code.claude.com/docs/en/hooks-guide) and [permissions](https://code.claude.com/docs/en/permissions).

## What Agent Flight Recorder can observe

Claude Code currently documents 33 hook events:

`SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`, `PreModelSwitch`, `PostModelSwitch`, and `SessionEnd`. See the official [lifecycle table](https://code.claude.com/docs/en/hooks#hook-lifecycle) and [event schemas](https://code.claude.com/docs/en/hooks#hook-events).

This covers prompts, expanded slash/MCP commands, tool inputs/results/failures/batches, shell commands, file-tool edits, filesystem-watch changes, permission asks and auto-mode denials, assistant display and final text, subagents/tasks/teams, configuration and instruction loading, compaction, worktrees, MCP elicitation, session boundaries, and API-stop failures.

There is no dedicated "test" event: test executions appear as ordinary `Bash` or `PowerShell` tool calls and must be classified from `tool_input.command`. There is also no documented hook payload for hidden chain-of-thought/reasoning stages or general per-turn token usage. The `Agent` tool's successful foreground `PostToolUse.tool_response` can include `totalTokens` and `usage`, but those describe only the subagent's final API request, not its full run. General [token/cost counters](https://code.claude.com/docs/en/monitoring-usage#token-counter) are documented separately under OpenTelemetry, not as hook input. A recorder should label these gaps honestly rather than infer private reasoning or complete usage.

## Common envelope and correlation IDs

Every event carries the documented [common input fields](https://code.claude.com/docs/en/hooks#common-input-fields), subject to the event examples and stated optionality:

- `session_id`: current Claude Code session ID.
- `prompt_id`: UUID for the current user prompt; absent before first user input; matches the OpenTelemetry `prompt.id` correlation attribute (Claude Code v2.1.196+).
- `transcript_path`: documented path to the local conversation JSON/JSONL. The file is written asynchronously and may lag the in-memory turn. For completed output use `Stop.last_assistant_message` or `SubagentStop.last_assistant_message`, not a just-in-time transcript read.
- `cwd`: working directory at hook invocation; unlike `${CLAUDE_PROJECT_DIR}`, it follows `cd` and worktree changes.
- `permission_mode`: when supplied, one of `default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, or `bypassPermissions` (`Manual` is delivered as `default`).
- `effort`: optional `{level}` with `low`, `medium`, `high`, `xhigh`, or `max` for supported models/tool-use contexts.
- `hook_event_name`: event name.
- `agent_id` and `agent_type`: added inside a subagent; `agent_type` also appears for `--agent` sessions.

Additional correlation identifiers are event-specific: `tool_use_id`, `MessageDisplay.turn_id`, `MessageDisplay.message_id` (a display UUID, explicitly not the API `msg_...` ID), `SubagentStart.agent_id`, `SubagentStop.agent_transcript_path`, and task IDs. They support a provider-grounded local event graph without guessing private storage keys; retain explicit ambiguity where an event, notably `PermissionRequest`, has no join ID.

## Event-specific input fields

The following table is a compact transcription of the official [per-event input schemas](https://code.claude.com/docs/en/hooks#hook-events). `?` means optional or conditionally present.

| Event | Additional input |
|---|---|
| `SessionStart` | `source` (`startup`, `resume`, `clear`, `compact`, `fork`), `model?`, `agent_type?`, `session_title?` |
| `Setup` | `trigger` (`init` or `maintenance`) |
| `InstructionsLoaded` | `file_path`, `memory_type`, `load_reason`, `globs?`, `trigger_file_path?`, `parent_file_path?` |
| `UserPromptSubmit` | `prompt` |
| `UserPromptExpansion` | `expansion_type`, `command_name`, `command_args`, `command_source`, original `prompt` |
| `MessageDisplay` | `turn_id`, `message_id`, zero-based `index`, `final`, streamed `delta` |
| `PreToolUse` | `tool_name`, provider-defined `tool_input`, `tool_use_id` |
| `PermissionRequest` | `tool_name`, `tool_input`, `permission_suggestions?`; intentionally no `tool_use_id` |
| `PostToolUse` | `tool_name`, `tool_input`, structured `tool_response`, `tool_use_id`, `duration_ms?` |
| `PostToolUseFailure` | `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt?`, `duration_ms?` |
| `PostToolBatch` | `tool_calls[]`, each containing `tool_name`, `tool_input`, `tool_use_id`, and serialized/content-block `tool_response` |
| `PermissionDenied` | `tool_name`, `tool_input`, `tool_use_id`, `reason`; auto mode only |
| `Notification` | `message`, `title?`, `notification_type` |
| `SubagentStart` | `agent_id`, `agent_type` |
| `SubagentStop` | `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks`, `session_crons` |
| `TaskCreated`, `TaskCompleted` | `task_id`, `task_subject`, `task_description?`, `teammate_name?`, deprecated `team_name?` |
| `Stop` | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` |
| `StopFailure` | `error`, `error_details?`, `last_assistant_message?` (the rendered API error string) |
| `TeammateIdle` | `teammate_name`, deprecated `team_name` |
| `ConfigChange` | `source`, `file_path?` |
| `CwdChanged` | `old_cwd`, `new_cwd` |
| `DirectoryAdded` | `directory`, `source` (`slash_command` or `register_repo_root`) |
| `FileChanged` | absolute `file_path`, `event` (`change`, `add`, `unlink`) |
| `WorktreeCreate` | `name` slug |
| `WorktreeRemove` | absolute `worktree_path` |
| `PreCompact` | `trigger` (`manual` or `auto`), `custom_instructions` |
| `PostCompact` | `trigger`, `compact_summary` |
| `PreModelSwitch` | `from_model`, `to_model`, `requested_model`, `source`, `context_tokens`, `prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd`, `pricing` |
| `PostModelSwitch` | Same model-switch fields; `source` additionally supports automatic and resume transitions |
| `SessionEnd` | `reason` (`clear`, `resume`, `logout`, `prompt_input_exit`, `other`) |
| `Elicitation` | `mcp_server_name`, `message`, `mode?`, `url?`, `elicitation_id?`, `requested_schema?` |
| `ElicitationResult` | `mcp_server_name`, `action`, `mode?`, `elicitation_id?`, `content?` |

Important tool shapes from [`PreToolUse`](https://code.claude.com/docs/en/hooks#pretooluse-input):

- `Bash`/`PowerShell`: `command`, optional `description`, optional timeout in milliseconds, and `run_in_background`.
- `Write`: absolute `file_path`, `content`.
- `Edit`: absolute `file_path`, `old_string`, `new_string`, `replace_all`.
- `Read`: absolute `file_path`, optional `offset`/`limit`; `Glob`/`Grep` expose their search pattern/path options.
- `Agent`: `prompt`, `description`, `subagent_type`, optional `model`; foreground `PostToolUse.tool_response` can expose agent run/status telemetry.
- MCP tools retain their provider-specific `tool_input`/response shape and are named `mcp__<server>__<tool>`.

`FileChanged` detects on-disk changes made by tools, shell commands, or outside processes, but only supplies path and change type, not a diff. To capture exact Claude edit intent, record `Write`/`Edit` `PreToolUse.tool_input`; to capture resulting code evolution, snapshot or diff the affected path locally after successful `PostToolUse`/`FileChanged` events.

## Configuration contract

Hooks use three JSON nesting levels: event key -> matcher group -> handler list. The canonical shape is:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/agent-flight-recorder",
            "args": ["ingest-hook"],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Official [configuration locations](https://code.claude.com/docs/en/hooks#hook-locations):

- `~/.claude/settings.json`: user-wide, local machine.
- `.claude/settings.json`: project-scoped, shareable/committable.
- `.claude/settings.local.json`: project-scoped, local and normally gitignored.
- managed policy settings: organization-wide.
- plugin `hooks/hooks.json`: enabled-plugin scope.
- skill or subagent YAML frontmatter: component lifecycle scope, using the same event/group/handler structure.

Handler types are `command`, `http`, `mcp_tool`, `prompt`, and experimental `agent`. Common handler fields include `type`, optional tool-event `if`, `timeout`, `statusMessage`, and skill-only `once`. Command-specific fields are `command`, `args`, `async`, `asyncRewake`, and `shell`. A global local recorder should use a `command` handler; HTTP hooks are not required and would undermine the local-only guarantee unless explicitly pointed at loopback.

For command hooks, `args` selects exec form: `command` is spawned directly with an argument vector and no shell. Omitting `args` selects shell form (`sh -c` on macOS/Linux; Git Bash or PowerShell on Windows), which interprets pipes, redirects, globs, substitutions, and quoting. Anthropic recommends exec form for path placeholders. `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, and `${CLAUDE_PLUGIN_DATA}` are available; `cwd` is the authoritative moving worktree/current-directory value. See [command hook fields](https://code.claude.com/docs/en/hooks#command-hook-fields).

## Synchronous, blocking, and permission behavior

Hooks are synchronous by default: Claude waits until matching hooks finish, and matching handlers run in parallel/deduplicate identical handlers. Command hooks receive JSON on stdin and return through exit code, stdout JSON, and stderr. `async: true` is command-only, returns control immediately, and cannot block or decide; its decision fields are ignored. An async process still running at `claude -p` teardown is killed, so a fast synchronous append is the more reliable baseline for the recorder. See [background hooks](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background).

Core response rules from [exit-code behavior](https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event) and [decision control](https://code.claude.com/docs/en/hooks#decision-control):

- Exit `0` means success. Structured control is a single JSON object on stdout. Most plain stdout is debug-only, except `SessionStart`, `UserPromptSubmit`, and `UserPromptExpansion`, where plain text becomes Claude context.
- Exit `2` is the blocking code where the event can still be prevented. Exit `1` and other nonzero codes are non-blocking for most events. `WorktreeCreate` is the exception: any nonzero exit fails creation.
- Blocking by exit `2`: `PreToolUse`, `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `SubagentStop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `ConfigChange` except policy changes, `PostToolBatch`, `PreCompact`, `Elicitation`, `ElicitationResult`, and `WorktreeCreate`.
- Post/side-effect events cannot undo what happened: `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `Notification`, `SubagentStart`, `SessionStart`, `Setup`, `SessionEnd`, `StopFailure`, `InstructionsLoaded`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `PostCompact`, and `WorktreeRemove` are non-blocking in the relevant sense.
- `PreToolUse` JSON uses `hookSpecificOutput.permissionDecision` = `allow`, `deny`, `ask`, or non-interactive-only `defer`; it can also return `updatedInput`, `permissionDecisionReason`, and `additionalContext`. Precedence across hooks is deny > defer > ask > allow. Allow does not override deny/ask permission rules.
- `PermissionRequest` runs when Claude is about to prompt (including non-interactive cases that otherwise auto-deny). It has no `tool_use_id`; its JSON `decision.behavior` is `allow` or `deny`, with optional `updatedInput`, `updatedPermissions`, `message`, and `interrupt`. Exit `2` alone is explicitly ignored for this event.
- `PermissionDenied` fires only for auto-mode classifier denials, not manual denial, a hook block, or a deny rule. `retry: true` tells the model it may retry but does not reverse the denial, and is ignored for no-verdict safety denials.
- The documented contract has no separate event carrying a user's eventual manual allow/deny response. A recorder can log the permission ask and later infer execution from `PostToolUse`, but should not label that inference as an explicit approval event.
- Timeouts on command/HTTP/MCP hooks fail open for `PreToolUse`: output is discarded and normal permission flow continues. Agent SDK callback timeouts have a different, fail-closed contract. A recorder hook should always return `0`; it must never accidentally alter agent behavior.

Universal JSON output includes `continue`, `stopReason`, `systemMessage`, and allowlisted `terminalSequence`; `suppressOutput` is accepted but currently has no effect. Event-specific blocking uses either top-level `decision: "block"`/`reason` or `hookSpecificOutput` as documented above. `PostToolUse` can replace what Claude sees via `updatedToolOutput`, but cannot reverse completed filesystem/network effects.

## Local execution and security constraints

Anthropic's [security section](https://code.claude.com/docs/en/hooks#security-considerations) is explicit:

- Command hooks execute with the full permissions of the local user and can read, modify, or delete anything that user can access.
- On macOS/Linux they run in their own session without a controlling terminal; they cannot open `/dev/tty`. Use JSON `systemMessage` or allowlisted `terminalSequence` rather than terminal writes.
- Interactive sessions hold back settings-file hooks until workspace trust is accepted. In `-p`/SDK sessions, the folder is treated as trusted and repository `.claude/settings.json` hooks can run without a dialog; review untrusted repos, use `--bare`, or pass `--settings '{"disableAllHooks": true}'`.
- Hook processes inherit Claude Code's environment except `OTEL_*` exporter variables, which Claude Code removes from spawned subprocesses. Do not depend on exporter credentials inside the hook.
- Validate stdin, quote variables, reject traversal, prefer absolute/exec-form paths, and skip secrets such as `.env`, `.git`, and private keys. For the recorder, apply redaction before persistence and never transmit the envelope.

## Recommended recorder mapping

- Session/turn: `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion`, `MessageDisplay`, `Stop`, `StopFailure`, `SessionEnd`.
- Reasoning-stage approximation (explicitly not chain-of-thought): tool batches, subagent/task lifecycle, compaction, and stop-continuation cycles.
- Commands/tests/retries: `PreToolUse` + success/failure/batch + `PermissionDenied`; correlate by `session_id`, `prompt_id`, and `tool_use_id`.
- File evolution: record `Write`/`Edit` intent and successful result; use `FileChanged` plus local snapshots/diffs for shell/external writes.
- Permissions: record `permission_mode`, `PermissionRequest`, hook decisions that the recorder itself emits (normally none), and `PermissionDenied`; leave manual response as unknown unless a future official event exposes it.
- Subagents: `SubagentStart`/`SubagentStop`, agent-specific transcript path/final text, and `Agent` tool response telemetry.

For a zero-cloud design, register a fast user-level command hook for every documented event, persist the raw envelope locally before normalization, redact secrets at ingestion, and treat the official payload as versioned/forward-compatible: preserve unknown fields rather than rejecting future additions.

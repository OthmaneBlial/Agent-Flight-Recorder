# Cursor hooks contract for Agent Flight Recorder

Research date: 2026-08-20. Sources are limited to current official Cursor documentation.

## Authoritative sources

- [Cursor Hooks reference](https://cursor.com/docs/hooks) — native events, JSON schemas, configuration, execution, cloud-agent support, and security behavior.
- [Cursor Third Party Hooks reference](https://cursor.com/docs/reference/third-party-hooks) — optional Claude Code compatibility, mapping, response formats, and limitations.

## Transport and identity

Native Cursor hooks are spawned processes. Command hooks receive one JSON object on stdin and return JSON on stdout. Every agent-session hook receives these base fields in addition to its event-specific fields:

| Field | Meaning |
| --- | --- |
| `conversation_id` | Stable across the multi-turn conversation. This is the best recorder session key. |
| `generation_id` | Changes with every user message. This is the best turn/generation key. |
| `model` | Legacy model slug configured in the composer. |
| `model_id` | Optional structured selected-model ID. |
| `model_params` | Optional `[{ "id": string, "value": string }]`, including settings such as thinking, context, or effort. |
| `hook_event_name` | Exact hook being invoked. |
| `cursor_version` | Cursor application version. |
| `workspace_roots` | Absolute workspace roots; supports multi-root workspaces. |
| `user_email` | Authenticated user email or `null`. |
| `transcript_path` | Main conversation transcript path or `null` when transcripts are disabled. |

`sessionStart.session_id` is explicitly the same value as `conversation_id`. `subagentStart` also provides `subagent_id`, `parent_conversation_id`, and the triggering `tool_call_id`. `workspaceOpen` runs outside an agent session and omits conversation/generation/model/session/transcript fields.

## Native event surface and event-specific input

All fields below are in addition to the common envelope.

| Event | Event-specific input | Response / behavior relevant to recording |
| --- | --- | --- |
| `sessionStart` | `session_id`, `is_background_agent`, optional `composer_mode` | Fire-and-forget: session creation cannot be blocked. Declared output is optional `env` and `additional_context`; `continue: false` is not enforced. |
| `sessionEnd` | `session_id`, `reason` (`completed`, `aborted`, `error`, `window_close`, `user_close`), `duration_ms`, `is_background_agent`, `final_status`, optional `error_message` | Fire-and-forget; output is logged but not used. |
| `beforeSubmitPrompt` | `prompt`, `attachments[{type: "file" | "rule", file_path}]` | Blocking-capable via `continue: false`; optional `user_message`. Runs after Send and before the backend request. |
| `preToolUse` | `tool_name`, `tool_input` object, `tool_use_id`, `cwd`, optional `agent_message` | `permission: "allow" | "deny"`, optional `user_message`, `agent_message`, and `updated_input`. `ask` is accepted by schema but not enforced here. Generic coverage includes Shell, Read, Write, MCP, Task, etc. |
| `postToolUse` | `tool_name`, `tool_input`, `tool_output` (JSON-stringified result, not raw terminal text), `tool_use_id`, `cwd`, `duration` ms | Optional `updated_mcp_tool_output` and `additional_context`. Successful tools only. |
| `postToolUseFailure` | `tool_name`, `tool_input`, `tool_use_id`, `cwd`, `error_message`, `failure_type` (`error`, `timeout`, `permission_denied`), `duration`, `is_interrupt` | Observational; no output fields. |
| `beforeShellExecution` | `command`, `cwd`, `sandbox` | Blocking-capable via `permission: "allow" | "deny" | "ask"`; optional `user_message` and `agent_message`. |
| `afterShellExecution` | `command`, full terminal `output`, `duration` ms excluding approval wait, `sandbox` | Observational. This is the strongest terminal/test-output signal. |
| `beforeMCPExecution` | `tool_name`, JSON-parameter `tool_input`, plus server `url` or `command` | Same permission response as `beforeShellExecution`. |
| `afterMCPExecution` | `tool_name`, JSON-string `tool_input`, JSON-string `result_json`, `duration` ms excluding approval wait | Observational. |
| `beforeReadFile` | Absolute `file_path`, full `content`, prompt `attachments` | Blocking-capable via `permission: "allow" | "deny"`; optional `user_message`. |
| `afterFileEdit` | Absolute `file_path`, `edits[{old_string, new_string}]` | Observational; exposes edit hunks, not a documented full resulting file snapshot. |
| `subagentStart` | `subagent_id`, `subagent_type`, `task`, `parent_conversation_id`, `tool_call_id`, `subagent_model`, `is_parallel_worker`, optional `git_branch` | `allow`/`deny` plus optional `user_message`; `ask` is treated as deny. |
| `subagentStop` | `subagent_type`, `status`, `task`, `description`, `summary`, `duration_ms`, `message_count`, `tool_call_count`, `loop_count`, `modified_files`, nullable `agent_transcript_path` | Optional `followup_message`, consumed only when completed. Default follow-up loop limit is 5 per script. The documented stop payload does not include `subagent_id`. |
| `afterAgentThought` | Fully aggregated `text`, optional `duration_ms` | Observational; one event after each completed thinking block. |
| `afterAgentResponse` | Final assistant-message `text` | Observational; fires after the assistant message completes. |
| `preCompact` | `trigger`, `context_usage_percent`, `context_tokens`, `context_window_size`, `message_count`, `messages_to_compact`, `is_first_compaction` | Observational and cannot block/modify compaction; may return a `user_message`. |
| `stop` | `status` (`completed`, `aborted`, `error`), `loop_count` | Optional non-empty `followup_message` is auto-submitted as the next user message. Default loop limit is 5 per script. |
| `beforeTabFileRead` | Absolute `file_path`, full `content` | Tab-only; allow/deny. No prompt attachments. |
| `afterTabFileEdit` | `file_path`, `edits` with `old_string`, `new_string`, range coordinates, `old_line`, `new_line` | Tab-only and observational; more detailed than agent `afterFileEdit`. |
| `workspaceOpen` | `hook_event_name`, `cursor_version`, `workspace_roots`, `user_email` | Fires in desktop and CLI at workspace open/folder change. May return absolute `pluginPaths`. No conversation identity. |

## Configuration contract

Native JSON has schema version `1`; `hooks` maps exact event names to arrays:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "command": ".cursor/hooks/flight-recorder",
        "timeout": 10,
        "matcher": "Shell|Read|Write|Grep|Delete|Task|MCP:.*",
        "failClosed": false
      }
    ],
    "postToolUse": [{ "command": ".cursor/hooks/flight-recorder" }],
    "postToolUseFailure": [{ "command": ".cursor/hooks/flight-recorder" }]
  }
}
```

Per-hook options are `command`, `type` (`command` default or `prompt`), `timeout` seconds, `loop_limit` (default 5 for Cursor `stop`/`subagentStop`, `null` removes the limit), `failClosed` (default `false`), and `matcher`. Prompt hooks additionally use a natural-language `prompt` and optional `model`.

Configuration sources, highest response priority first:

1. Enterprise: macOS `/Library/Application Support/Cursor/hooks.json`, Linux/WSL `/etc/cursor/hooks.json`, Windows `C:\\ProgramData\\Cursor\\hooks.json`.
2. Team: Enterprise web-dashboard distribution.
3. Project: `<project-root>/.cursor/hooks.json`.
4. User: `~/.cursor/hooks.json`.

All matching hooks from all sources run; higher-priority sources win when responses conflict. Cursor watches config files and reloads them on save. Project commands run from the project root; user commands from `~/.cursor/`; enterprise/team commands from their managed config directories. Therefore a project config should reference `.cursor/hooks/...`, while a user config can reference `./hooks/...`.

Useful matchers include tool names (`Shell`, `Read`, `Write`, `Grep`, `Delete`, `Task`, `MCP:<tool_name>`), subagent types, regex-like shell command text, `UserPromptSubmit`, `Stop`, `AgentResponse`, and `AgentThought`.

## Synchronous, blocking, and failure semantics

- Command hooks use stdin/stdout JSON. Exit `0` means success and Cursor consumes the JSON. Exit `2` blocks the action, equivalent to `permission: "deny"`. Other nonzero exits fail open by default.
- `failClosed: true` changes crash, timeout, or invalid-JSON behavior to block; the docs specifically recommend it for security-critical pre-MCP policy. For an observability-only recorder, `false` preserves agent availability.
- The action is decision-gated where the event documents a pre-action response: `beforeSubmitPrompt`, `preToolUse`, `subagentStart`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, and `beforeTabFileRead`.
- Completed-action hooks cannot undo the action. Some can still alter later model context (`postToolUse`), schedule another iteration (`stop`, completed `subagentStop`), or display a message (`preCompact`).
- `sessionStart` and `sessionEnd` are explicitly fire-and-forget. The docs do not promise a global sequential ordering contract beyond each event's documented before/after point, so the recorder should timestamp on receipt and tolerate late or missing lifecycle events.

## Local execution and security implications

- Native command hooks are the appropriate surface for a local-only recorder: they execute a command and exchange JSON over stdio. Prompt hooks are LLM-evaluated, and the docs do not promise local evaluation, so they should not be used by a strict no-cloud integration.
- A user-level hook is the safest default installation for Agent Flight Recorder: it stays outside repositories and applies globally. Project hooks are version-controlled code/config and run only in trusted workspaces, but they remain repository-controlled executable commands.
- Payloads can contain prompt text, full file contents, shell output, MCP input/results, fully aggregated thought text, authenticated email, and transcript paths. Recorder storage needs local access controls, redaction, bounded retention, and no automatic network forwarding.
- Hook subprocesses receive `CURSOR_PROJECT_DIR`, `CURSOR_VERSION`, optional `CURSOR_USER_EMAIL`, optional `CURSOR_TRANSCRIPT_PATH`, optional `CURSOR_CODE_REMOTE="true"`, and the Claude-compatible `CLAUDE_PROJECT_DIR` alias. Environment returned by `sessionStart` is passed to later hooks in that session.
- Cloud agents are not equivalent to local Cursor: user hooks are unavailable; only command hooks run; early read-only turns may emit no hooks; and cloud does not support `sessionStart`, `sessionEnd`, MCP, Tab, or `workspaceOpen` hooks. A local recorder should not claim complete cloud-agent capture.

## Coverage gaps the product must represent honestly

- No dedicated token-usage or cost event. `preCompact` exposes current context token counts, not per-generation input/output/cache/billing usage.
- No dedicated native permission-decision event. A denial can appear as `postToolUseFailure.failure_type = "permission_denied"`, and recorder-owned pre-hooks know the decision they return, but the contract does not expose every built-in user approval outcome. Cursor's Claude compatibility explicitly does not support Claude's `PermissionRequest` event.
- No first-class test event; classify test runs from `Shell` commands/results.
- No first-class retry event; infer retries from repeated tool calls/generations and failure/success sequences.
- Agent `afterFileEdit` gives old/new edit strings but no documented full before/after file snapshot. Snapshot the local file on receipt if full code-evolution replay is required.
- The hook schema documents model selection and reasoning text, but not a structured chain of internal reasoning stages beyond completed `afterAgentThought` blocks.
- Hooks are event callbacks, not a completeness guarantee. Process failure, timeout, unsupported/cloud surfaces, disabled transcripts, or Cursor version drift must be visible as capture gaps rather than silently synthesized.

## Recommended native capture set

For the broadest local Cursor IDE replay, register the same fast, non-blocking local command for all 21 native events: `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `afterAgentThought`, `afterAgentResponse`, `preCompact`, `stop`, `beforeTabFileRead`, `afterTabFileEdit`, and `workspaceOpen`.

Prefer the native Cursor format. Claude Code files are supported only after enabling third-party configs and map a smaller set (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`); `Notification` and `PermissionRequest` are not mapped. Native format is therefore required for maximum Flight Recorder coverage.

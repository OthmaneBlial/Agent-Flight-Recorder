# Codex hooks: official contract draft

Verified 2026-09-01 against OpenAI's official [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Supported live events

Codex documents 11 lifecycle hooks: `SessionStart`, `SessionEnd`, `SubagentStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `SubagentStop`, and `Stop`.

Common input includes `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, and `model`. Turn-scoped events can add `turn_id`; tool events include `tool_name`, `tool_input`, and, except for permission requests, a `tool_use_id`. Post-tool events can include output and duration. The recorder preserves every native field and accepts future additions instead of rejecting them.

Codex reads hooks from user-level `~/.codex/hooks.json` and project-level `.codex/hooks.json`, with additional configuration possible through `config.toml`. JSON hooks use the event to matcher-group to command-handler structure. Agent Flight Recorder structurally merges only its marked handlers and remains dry-run-first for install, uninstall, and rollback.

## Stability and privacy limits

The official reference explicitly says that the file named by `transcript_path` is not a stable interface and may change. Agent Flight Recorder therefore treats direct JSONL parsing as a version-tested historical/backfill adapter, not the preferred live contract. Official hooks are the primary live capture path.

Codex also offers OpenTelemetry log and trace export. Raw user prompts are disabled by default and require an explicit opt-in. Agent Flight Recorder does not currently ingest that exporter; missing fields remain null rather than estimated.

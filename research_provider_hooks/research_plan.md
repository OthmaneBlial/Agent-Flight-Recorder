# Provider hook contract research plan

## Main question

Which current, officially documented local hook events and payload fields can Agent Flight Recorder use to capture Claude Code and Cursor activity without reading undocumented private storage or sending data to a cloud service?

## Subtopics

1. Claude Code hooks
   - Confirm supported lifecycle, prompt, tool, permission, failure, subagent, compaction, and session events.
   - Record stable input fields, configuration locations, command execution behavior, and local-security constraints.

2. Cursor hooks
   - Confirm supported prompt, shell, tool, file, MCP, subagent, and session events.
   - Record stable input fields, configuration locations, response behavior, and local-security constraints.

## Synthesis

Map official provider events into the recorder's canonical event kinds, implement a stdin-based local hook command and compatible JSON envelope, and document only configuration that authoritative sources support. Keep gaps explicit where a provider does not expose a signal.

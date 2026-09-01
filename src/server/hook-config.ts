import type { Provider } from '../shared/types.js';

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'Setup',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'MessageDisplay',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'Elicitation',
  'ElicitationResult',
  'PreModelSwitch',
  'PostModelSwitch',
  'SessionEnd',
] as const;

export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'SubagentStop',
  'Stop',
] as const;

export const CURSOR_HOOK_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'subagentStart',
  'subagentStop',
  'afterAgentThought',
  'afterAgentResponse',
  'preCompact',
  'stop',
  'beforeTabFileRead',
  'afterTabFileEdit',
  'workspaceOpen',
] as const;

export function generateHookConfig(
  provider: Extract<Provider, 'codex' | 'claude' | 'cursor'>,
  executable: string,
  script: string,
  dataDir: string,
  policyArgs: string[] = [],
): unknown {
  if (provider === 'claude') {
    const handler = {
      type: 'command',
      command: executable,
      args: [script, 'hook', '--provider=claude', `--data-dir=${dataDir}`, ...policyArgs],
      timeout: 5,
    };
    return {
      hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, [{ hooks: [handler] }]])),
    };
  }
  if (provider === 'codex') {
    const command = [executable, script, 'hook', '--provider=codex', `--data-dir=${dataDir}`, ...policyArgs].map(shellQuote).join(' ');
    const handler = { type: 'command', command, timeout: 5 };
    return {
      hooks: Object.fromEntries(CODEX_HOOK_EVENTS.map((event) => [event, [{ hooks: [handler] }]])),
    };
  }
  const command = [executable, script, 'hook', '--provider=cursor', `--data-dir=${dataDir}`, ...policyArgs].map(shellQuote).join(' ');
  const handler = { type: 'command', command, timeout: 5, failClosed: false };
  return {
    version: 1,
    hooks: Object.fromEntries(CURSOR_HOOK_EVENTS.map((event) => [event, [handler]])),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

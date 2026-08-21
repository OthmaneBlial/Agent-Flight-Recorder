import type { Provider } from '../shared/types.js';

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse',
  'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure',
  'PostToolBatch', 'Notification', 'MessageDisplay', 'SubagentStart', 'SubagentStop',
  'TaskCreated', 'TaskCompleted', 'Stop', 'StopFailure', 'TeammateIdle',
  'InstructionsLoaded', 'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'FileChanged',
  'WorktreeCreate', 'WorktreeRemove', 'PreCompact', 'PostCompact', 'Elicitation',
  'ElicitationResult', 'SessionEnd',
] as const;

export const CURSOR_HOOK_EVENTS = [
  'sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse',
  'postToolUseFailure', 'beforeShellExecution', 'afterShellExecution',
  'beforeMCPExecution', 'afterMCPExecution', 'beforeReadFile', 'afterFileEdit',
  'subagentStart', 'subagentStop', 'afterAgentThought', 'afterAgentResponse',
  'preCompact', 'stop', 'beforeTabFileRead', 'afterTabFileEdit', 'workspaceOpen',
] as const;

export function generateHookConfig(
  provider: Extract<Provider, 'claude' | 'cursor'>,
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

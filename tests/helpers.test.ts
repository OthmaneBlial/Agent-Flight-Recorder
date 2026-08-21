import { describe, expect, it } from 'vitest';
import { eventKindForTool, extractCommands, extractPaths, inferResultStatus, isTestCommand, toolNames } from '../src/server/adapters/helpers.js';

describe('adapter helpers', () => {
  it('classifies nested Codex tool orchestration', () => {
    const input = `const result = await tools.exec_command({ cmd: "npm run test", workdir: "/tmp/project" });`;
    expect(toolNames('exec', input)).toEqual(['exec', 'exec_command']);
    expect(extractCommands(input)).toBe('npm run test');
    expect(eventKindForTool('exec', input)).toBe('test');
    expect(isTestCommand('pnpm verify')).toBe(true);
  });

  it('extracts affected paths from native patch calls', () => {
    const patch = '*** Begin Patch\n*** Update File: src/App.tsx\n*** Add File: src/new.ts\n*** End Patch';
    expect(eventKindForTool('apply_patch', patch)).toBe('file');
    expect(extractPaths(patch)).toEqual(['src/App.tsx', 'src/new.ts']);
    const escaped = 'const patch = "*** Begin Patch\\n*** Update File: src/App.tsx\\n+next\\n*** End Patch";';
    expect(extractPaths(escaped)).toEqual(['src/App.tsx']);
  });

  it('recognizes failed command evidence', () => {
    expect(inferResultStatus({ output: 'Process exited with code 2' })).toBe('error');
    expect(inferResultStatus({ output: 'Script completed\nexit_code: 0' })).toBe('success');
  });

  it('does not mistake arbitrary JavaScript write calls for file mutations', () => {
    const wrapper = 'await tools.mcp__node_repl__js({ code: `nodeRepl.write(await browser.documentation())` })';
    expect(eventKindForTool('exec mcp__node_repl__js', wrapper)).toBe('terminal');
    expect(eventKindForTool('exec apply_patch', '*** Begin Patch\n*** Update File: src/app.ts')).toBe('file');
    expect(eventKindForTool('exec_command', { cmd: 'echo ok', sandbox_permissions: 'require_escalated' })).toBe('terminal');
  });
});

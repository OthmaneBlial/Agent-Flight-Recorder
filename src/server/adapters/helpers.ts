import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { EventKind, EventStatus } from '../../shared/types.js';

export function stableId(...parts: Array<string | number | null | undefined>): string {
  return createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u001f'))
    .digest('hex')
    .slice(0, 24);
}

export function projectName(cwd: string | null | undefined): string {
  if (!cwd) return 'Unknown workspace';
  return basename(cwd.replace(/\/$/, '')) || cwd;
}

export function summarize(text: string, max = 280): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trimEnd()}…`;
}

export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      return typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export function eventKindForTool(name: string, input: unknown): EventKind {
  const lowerName = name.toLowerCase();
  const serialized = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  const record = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const operation = [record.action, record.operation, record.type]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (lowerName.includes('permission')) return 'permission';
  if (
    /\b(apply_patch|edit|write|multiedit|str_replace|create_file|delete_file)\b/.test(`${lowerName} ${operation}`) ||
    /\*\*\* Begin Patch|tools\.apply_patch\s*\(/i.test(serialized) ||
    ['old_string', 'new_string', 'oldText', 'newText', 'patch'].some((key) => key in record)
  )
    return 'file';
  if (isTestCommand(serialized)) return 'test';
  if (/\b(exec|shell|bash|terminal|command)\b/.test(lowerName) || ['cmd', 'command', 'script'].some((key) => typeof record[key] === 'string'))
    return 'terminal';
  return 'tool';
}

export function isTestCommand(value: string): boolean {
  return /(^|[\s"'])(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|verify|lint|typecheck|build)\b|\b(vitest|jest|pytest|cargo\s+test|go\s+test|gradle\w*\s+test|xcodebuild\s+test|playwright\s+test)\b/i.test(
    value,
  );
}

export function extractCommands(input: unknown): string | null {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['cmd', 'command', 'script']) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
  }
  if (typeof input !== 'string') return null;
  const matches = [...input.matchAll(/\b(?:cmd|command):\s*(["'`])([\s\S]*?)\1(?=\s*[,}])/g)];
  if (matches.length) return matches.map((match) => unescapeLiteral(match[2])).join('\n\n');
  return input.length <= 4000 ? input : `${input.slice(0, 4000)}\n…`;
}

export function extractPaths(input: unknown): string[] {
  const serialized = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  const patchText = serialized.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  const paths = new Set<string>();
  for (const match of patchText.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n\r]+)/g)) paths.add(match[1].trim().replace(/["'`;]+$/, ''));
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['path', 'filePath', 'file_path', 'filename']) {
      if (typeof record[key] === 'string') paths.add(record[key] as string);
    }
  }
  return [...paths];
}

export function toolNames(name: string, input: unknown): string[] {
  const names = new Set<string>();
  if (name) names.add(name.replace(/^functions\./, ''));
  if (typeof input === 'string') {
    for (const match of input.matchAll(/\btools\.([a-zA-Z0-9_]+)/g)) names.add(match[1]);
  }
  return [...names];
}

export function inferResultStatus(output: unknown): EventStatus {
  const serialized = typeof output === 'string' ? output : JSON.stringify(output ?? {});
  if (
    /"isError"\s*:\s*true|process exited with code [1-9]\d*|exit_code["']?\s*:\s*[1-9]\d*|script failed|permission denied|command not found/i.test(serialized)
  )
    return 'error';
  if (/denied|blocked|requires approval/i.test(serialized)) return 'blocked';
  return 'success';
}

export function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return textFromContent(output);
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    if (typeof record.output === 'string') return record.output;
    if (Array.isArray(record.content)) return textFromContent(record.content);
  }
  return JSON.stringify(output ?? {});
}

function unescapeLiteral(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

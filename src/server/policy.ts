import type { EvidencePolicySummary } from '../shared/types.js';
import type { EventInput } from './model.js';

export interface EvidencePolicy extends EvidencePolicySummary {
  sensitivePathPatterns: RegExp[];
}

export interface EvidencePolicyOverrides {
  redactionMode?: EvidencePolicySummary['redactionMode'];
  rawRetentionDays?: number | null;
  snapshotRetentionDays?: number | null;
  snapshotMaxBytes?: number;
}

const SENSITIVE_KEY = /(^|_)(authorization|auth|password|passwd|secret|api_?key|access_?key|private_?key|client_?secret|cookie|session_?token|bearer_?token)($|_)/i;
const INLINE_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]'],
  [/\b(sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED:credential]'],
  [/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY))\s*=\s*([^\s"']+)/g, '$1=[REDACTED]'],
  [/(https?:\/\/[^\s:/]+:)[^@\s]+@/g, '$1[REDACTED]@'],
];

export function loadEvidencePolicy(overrides: EvidencePolicyOverrides = {}, environment: NodeJS.ProcessEnv = process.env): EvidencePolicy {
  const redactionMode = overrides.redactionMode ?? parseMode(environment.AFR_REDACTION_MODE);
  const rawRetentionDays = overrides.rawRetentionDays ?? positiveInteger(environment.AFR_RAW_RETENTION_DAYS);
  const snapshotRetentionDays = overrides.snapshotRetentionDays ?? positiveInteger(environment.AFR_SNAPSHOT_RETENTION_DAYS);
  const snapshotMaxBytes = overrides.snapshotMaxBytes ?? positiveInteger(environment.AFR_SNAPSHOT_MAX_BYTES) ?? 2 * 1024 * 1024;
  return {
    redactionMode,
    rawRetentionDays,
    snapshotRetentionDays,
    snapshotMaxBytes,
    sensitiveFilePolicy: 'skip',
    sensitivePathPatterns: [
      /(^|[/\\])\.env(?:\.|$)/i,
      /(^|[/\\])\.git([/\\]|$)/i,
      /(^|[/\\])(?:id_rsa|id_ed25519|credentials?|secrets?)(?:\.|$)/i,
      /\.(?:pem|p12|pfx|key|keystore)$/i,
    ],
  };
}

export function policySummary(policy: EvidencePolicy): EvidencePolicySummary {
  return {
    redactionMode: policy.redactionMode,
    rawRetentionDays: policy.rawRetentionDays,
    snapshotRetentionDays: policy.snapshotRetentionDays,
    snapshotMaxBytes: policy.snapshotMaxBytes,
    sensitiveFilePolicy: policy.sensitiveFilePolicy,
  };
}

export function sanitizeEvent(event: EventInput, policy: EvidencePolicy): EventInput {
  if (policy.redactionMode === 'off') return event;
  return {
    ...event,
    title: redactString(event.title),
    summary: redactString(event.summary),
    command: event.command === null ? null : redactString(event.command),
    payload: redactValue(event.payload),
    raw: policy.redactionMode === 'strict' ? undefined : redactValue(event.raw),
  };
}

export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (depth > 40) return '[REDACTED:max-depth]';
  if (seen.has(value)) return '[REDACTED:circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1, seen));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key.replace(/-/g, '_')) ? `[REDACTED:${key}]` : redactValue(entry, depth + 1, seen);
  }
  return result;
}

export function redactString(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of INLINE_PATTERNS) redacted = redacted.replace(pattern, replacement);
  return redacted;
}

function parseMode(value: string | undefined): EvidencePolicySummary['redactionMode'] {
  return value === 'mask' || value === 'strict' ? value : 'off';
}

function positiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

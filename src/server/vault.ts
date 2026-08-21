import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const PREFIX = 'afr.enc.v1';
const KEYCHAIN_SERVICE = 'com.agent-flight-recorder.store';

export type VaultKeyProvider = 'environment' | 'macos-keychain' | 'protected-key-file';

export class EvidenceVault {
  readonly keyProvider: VaultKeyProvider;
  readonly keyFingerprint: string;
  private readonly key: Buffer;

  constructor(databasePath: string) {
    const resolved = resolveKey(databasePath);
    this.key = resolved.key;
    this.keyProvider = resolved.provider;
    this.keyFingerprint = createHash('sha256').update(this.key).digest('hex').slice(0, 16);
  }

  isSealed(value: string | Uint8Array): boolean {
    const text = typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
    return text.startsWith(`${PREFIX}:`);
  }

  sealText(value: string, purpose: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  openText(value: string | Uint8Array, purpose: string): string {
    const text = typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
    if (!this.isSealed(text)) return text;
    const [format, ivEncoded, tagEncoded, ciphertextEncoded] = text.split(':');
    if (format !== PREFIX || !ivEncoded || !tagEncoded || ciphertextEncoded === undefined) throw new Error('Malformed encrypted evidence envelope');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivEncoded, 'base64'));
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(Buffer.from(tagEncoded, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(`Unable to decrypt recorder evidence with key ${this.keyFingerprint}`);
    }
  }
}

function resolveKey(databasePath: string): { key: Buffer; provider: VaultKeyProvider } {
  const configured = process.env.AFR_STORE_KEY;
  if (configured) return { key: decodeKey(configured), provider: 'environment' };

  const testing = Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test');
  if (process.platform === 'darwin' && !testing) {
    const account = createHash('sha256').update(databasePath).digest('hex');
    try {
      const existing = execFileSync('/usr/bin/security', ['find-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return { key: decodeKey(existing), provider: 'macos-keychain' };
    } catch {
      const generated = randomBytes(32).toString('base64');
      try {
        execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-a', account, '-s', KEYCHAIN_SERVICE, '-w', generated], { stdio: 'ignore' });
        return { key: Buffer.from(generated, 'base64'), provider: 'macos-keychain' };
      } catch {
        throw new Error('Recorder storage encryption requires an unlocked macOS Keychain or AFR_STORE_KEY.');
      }
    }
  }

  const keyPath = `${databasePath}.key`;
  if (existsSync(keyPath)) return { key: decodeKey(readFileSync(keyPath, 'utf8').trim()), provider: 'protected-key-file' };
  const generated = randomBytes(32);
  writeFileSync(keyPath, generated.toString('base64'), { mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') chmodSync(keyPath, 0o600);
  return { key: generated, provider: 'protected-key-file' };
}

function decodeKey(value: string): Buffer {
  const key = /^[a-f\d]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.byteLength !== 32) throw new Error('AFR_STORE_KEY must encode exactly 32 bytes (base64 or 64 hex characters).');
  return key;
}

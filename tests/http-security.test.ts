import { describe, expect, it } from 'vitest';
import { isTrustedHost, isTrustedOrigin } from '../src/server/http.js';

describe('loopback HTTP boundary', () => {
  it('accepts only explicit loopback Host values', () => {
    expect(isTrustedHost('127.0.0.1:4174')).toBe(true);
    expect(isTrustedHost('localhost:4174')).toBe(true);
    expect(isTrustedHost('[::1]:4174')).toBe(true);
    expect(isTrustedHost('localhost.evil.example:4174')).toBe(false);
    expect(isTrustedHost('evil.example:4174')).toBe(false);
    expect(isTrustedHost(undefined)).toBe(false);
  });

  it('allows non-browser clients and rejects non-loopback browser origins', () => {
    expect(isTrustedOrigin(undefined)).toBe(true);
    expect(isTrustedOrigin('http://127.0.0.1:4174')).toBe(true);
    expect(isTrustedOrigin('http://localhost:4174')).toBe(true);
    expect(isTrustedOrigin('http://[::1]:4174')).toBe(true);
    expect(isTrustedOrigin('https://evil.example')).toBe(false);
    expect(isTrustedOrigin('null')).toBe(false);
  });
});

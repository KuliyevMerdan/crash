import { describe, expect, it } from 'vitest';
import { BootError, readConfig } from './config.js';

describe('the boot contract', () => {
  it('boots a development server from nothing, with faults on and an in-memory store', () => {
    const config = readConfig({});
    expect(config).toMatchObject({
      env: 'development',
      database: ':memory:',
      faults: true,
      port: 8080,
    });
    expect(config.chain).toMatchObject({ length: 1_000_000, rotateAt: 50_000, devSeed: null });
  });

  it('refuses every development convenience in production, naming them all at once', () => {
    let error: unknown;
    try {
      readConfig({
        CRASH_ENV: 'production',
        CRASH_DB: ':memory:',
        CRASH_DEV_CHAIN_SEED: 'ab'.repeat(32),
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BootError);
    expect(error instanceof BootError && error.violations).toEqual([
      expect.stringContaining(':memory:'),
      expect.stringContaining('CRASH_DEV_CHAIN_SEED'),
    ]);
  });

  it('requires a database file in production, and keeps faults off unless asked', () => {
    expect(() => readConfig({ CRASH_ENV: 'production' })).toThrow(/CRASH_DB/);
    const config = readConfig({ CRASH_ENV: 'production', CRASH_DB: '/data/crash.db' });
    expect(config.faults).toBe(false);
    expect(
      readConfig({ CRASH_ENV: 'production', CRASH_DB: 'x.db', CRASH_FAULTS: 'on' }).faults,
    ).toBe(true);
  });

  it.each([
    [{ CRASH_DEV_CHAIN_SEED: 'nope' }, /64 lowercase hex/],
    [{ CRASH_CHAIN_LENGTH: '100', CRASH_CHAIN_ROTATE_AT: '100' }, /ROTATE_AT/],
    [{ PORT: 'eighty' }, /PORT/],
  ])('refuses %j', (env, message) => {
    expect(() => readConfig(env)).toThrow(message);
  });
});

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
      staticDir: null, // Vite serves the page in development
    });
    expect(config.chain).toMatchObject({
      length: 1_000_000,
      rotateAt: 50_000,
      devSeed: null,
      firstId: 1,
    });
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

  it('names the first chain by its boot second only when asked — a host without a disk', () => {
    expect(readConfig({ CRASH_CHAIN_FIRST_ID: 'boot' }).chain.firstId).toBe('boot');
    expect(readConfig({ CRASH_CHAIN_FIRST_ID: '7' }).chain.firstId).toBe(7);
    expect(() => readConfig({ CRASH_CHAIN_FIRST_ID: '0' })).toThrow(/CRASH_CHAIN_FIRST_ID/);
  });

  it('serves the web app only when told where it is', () => {
    expect(readConfig({ CRASH_STATIC_DIR: '/app/web' }).staticDir).toBe('/app/web');
    expect(() => readConfig({ CRASH_STATIC_DIR: '' })).toThrow(/CRASH_STATIC_DIR/);
  });

  it.each([
    [{ CRASH_DEV_CHAIN_SEED: 'nope' }, /64 lowercase hex/],
    [{ CRASH_CHAIN_LENGTH: '100', CRASH_CHAIN_ROTATE_AT: '100' }, /ROTATE_AT/],
    [{ PORT: 'eighty' }, /PORT/],
  ])('refuses %j', (env, message) => {
    expect(() => readConfig(env)).toThrow(message);
  });
});

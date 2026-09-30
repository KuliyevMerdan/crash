import { CrashClient } from '@crash/client-core';
import { browserTransport, socketUrl } from './transport.js';

const TOKEN_KEY = 'crash.token';
const NICK_KEY = 'crash.nick';

/** Storage that may not exist — a private window, blocked site data — and must never break the game. */
const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // No storage: the next visit is a new wallet. Play money; nothing is lost that matters.
    }
  },
};

function nick(): string {
  const saved = storage.get(NICK_KEY);
  if (saved !== null) return saved;
  const made = `player-${Math.floor(1000 + Math.random() * 9000)}`;
  storage.set(NICK_KEY, made);
  return made;
}

/**
 * The one client for the page — the socket outlives any React render — and a way to send a raw
 * frame down its socket, which only the dev hooks use (a production server ignores dev messages).
 */
export function createClient(): { client: CrashClient; sendRaw(message: object): void } {
  const transport = browserTransport(socketUrl(window.location));
  const client = new CrashClient({
    transport,
    clock: { now: () => performance.timeOrigin + performance.now() },
    scheduler: {
      setTimeout(fn, ms) {
        const handle = window.setTimeout(fn, ms);
        return { cancel: () => window.clearTimeout(handle) };
      },
    },
    nick: nick(),
    token: storage.get(TOKEN_KEY),
    onToken: (token) => storage.set(TOKEN_KEY, token),
  });
  return {
    client,
    sendRaw(message) {
      const socket = transport.current();
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
  };
}

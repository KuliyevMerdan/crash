import type { ClientEvent, ClientState, CrashClient } from '@crash/client-core';
import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * The client's state for React — coarse changes only. The store notifies on every message, ticks
 * included, but React bails out when the snapshot is the same object, and the shell renders nothing
 * that changes per tick; the canvas reads the client directly.
 */
export function useClientState(client: CrashClient): ClientState {
  return useSyncExternalStore(
    (notify) => client.subscribe(notify),
    () => client.getState(),
  );
}

/** Desync — a drifting tick or a frame the client could not parse — seen in the last 10 s. */
export function useDesync(client: CrashClient): boolean {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(
    () =>
      client.subscribe((_state: ClientState, event: ClientEvent) => {
        if (event.type === 'drift' || event.type === 'protocol-error')
          setUntil(Date.now() + 10_000);
      }),
    [client],
  );
  useEffect(() => {
    if (until <= now) return;
    const timer = window.setTimeout(() => setNow(Date.now()), until - now);
    return () => window.clearTimeout(timer);
  }, [until, now]);
  return until > now;
}

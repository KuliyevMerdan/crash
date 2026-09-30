import type { Transport } from '@crash/client-core';

/** The browser's `WebSocket` behind `client-core`'s `Transport` port — the one DOM-side adapter. */
export function browserTransport(url: string): Transport & { current(): WebSocket | null } {
  let current: WebSocket | null = null;
  return {
    /** The live socket — for the dev hooks, which send dev messages (§9) down the player's own link. */
    current: () => current,
    connect(handlers) {
      const socket = new WebSocket(url);
      current = socket;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        handlers.close();
      };
      socket.addEventListener('open', () => handlers.open());
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') handlers.message(event.data);
      });
      socket.addEventListener('close', close);
      socket.addEventListener('error', close);
      return {
        send: (frame) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(frame);
        },
        close: () => {
          closed = true; // a close the client asked for is not a drop to report back
          socket.close();
        },
      };
    },
  };
}

/** `ws://` or `wss://` to `/ws` on the page's own origin — Vite proxies it in development. */
export function socketUrl(location: Location): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

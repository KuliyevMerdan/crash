// FIXTURE — must be rejected by `packages-no-server-libs`: the engine returns effects, it never emits.
import { WebSocketServer } from 'ws';

export const leak = WebSocketServer;

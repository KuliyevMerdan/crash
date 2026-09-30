import type { z } from 'zod';
import {
  CLIENT_MESSAGE_TYPES,
  SERVER_MESSAGE_TYPES,
  clientMessage,
  serverMessage,
  type ClientMessage,
  type ServerMessage,
} from './messages.js';

/**
 * Parsing at the boundary, on both sides (CLAUDE.md § Other rules), with invariant 9 built in:
 * unknown fields are stripped, an unknown `type` is **dropped, not refused**, and only a known type
 * whose payload fails its schema is malformed — which the server answers with `MALFORMED_MESSAGE`
 * and the client treats as the deploy-skew bug it is.
 */
export type ParseOutcome<T> =
  | { readonly kind: 'ok'; readonly message: T }
  | { readonly kind: 'unknown-type'; readonly type: string | undefined }
  | { readonly kind: 'malformed'; readonly type: string; readonly issues: readonly string[] };

function parserFor<T>(schema: z.ZodType<T>, types: readonly string[]) {
  const known = new Set(types);
  return (value: unknown): ParseOutcome<T> => {
    const type =
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      typeof value.type === 'string'
        ? value.type
        : undefined;
    if (type === undefined || !known.has(type)) return { kind: 'unknown-type', type };

    const result = schema.safeParse(value);
    if (result.success) return { kind: 'ok', message: result.data };
    return {
      kind: 'malformed',
      type,
      issues: result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  };
}

/** The server's side of the socket: every inbound frame, before it reaches the engine. */
export const parseClientMessage = parserFor<ClientMessage>(clientMessage, CLIENT_MESSAGE_TYPES);

/** The client's side of the socket. */
export const parseServerMessage = parserFor<ServerMessage>(serverMessage, SERVER_MESSAGE_TYPES);

/**
 * A text frame, as `ws` and the browser `WebSocket` both deliver it. Not JSON at all is treated like
 * an unknown type — dropped and logged — since there is no `type` to be malformed against.
 */
export function decodeFrame(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

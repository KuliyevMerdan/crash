import { z } from 'zod';
import { ulid } from './primitives.js';

/**
 * The three-class taxonomy (docs/protocol.md §6). **The class is a function of the code**: this table
 * is the one place that says which, and an `error` whose class disagrees with its code fails to
 * parse. The client branches on the class, never on a message string.
 */
export const ERROR_CODES = {
  PLAYER: [
    'INSUFFICIENT_FUNDS',
    'BET_OUT_OF_RANGE',
    'AUTO_CASHOUT_OUT_OF_RANGE',
    'ONE_BET_PER_ROUND',
    'BETTING_CLOSED',
    'NOT_RUNNING',
    'TOO_LATE',
    'DUPLICATE_BET_ID',
    'UNKNOWN_BET',
    'MALFORMED_MESSAGE',
  ],
  SESSION: ['SESSION_INVALID', 'NOT_AUTHENTICATED'],
  SYSTEM: ['INTERNAL', 'UNAVAILABLE'],
} as const;

export type ErrorClass = keyof typeof ERROR_CODES;
export type PlayerErrorCode = (typeof ERROR_CODES.PLAYER)[number];
export type SessionErrorCode = (typeof ERROR_CODES.SESSION)[number];
export type SystemErrorCode = (typeof ERROR_CODES.SYSTEM)[number];
export type ErrorCode = PlayerErrorCode | SessionErrorCode | SystemErrorCode;

const CLASS_OF_CODE: ReadonlyMap<ErrorCode, ErrorClass> = new Map<ErrorCode, ErrorClass>([
  ...ERROR_CODES.PLAYER.map((code) => [code, 'PLAYER'] as const),
  ...ERROR_CODES.SESSION.map((code) => [code, 'SESSION'] as const),
  ...ERROR_CODES.SYSTEM.map((code) => [code, 'SYSTEM'] as const),
]);

/** The class a code belongs to — what the server stamps on an error it sends. */
export function classOf(code: ErrorCode): ErrorClass {
  const cls = CLASS_OF_CODE.get(code);
  if (cls === undefined) throw new Error(`unclassified error code: ${code}`); // unreachable: the map is total
  return cls;
}

const errorFields = {
  type: z.literal('error'),
  message: z.string(),
  roundId: ulid.optional(),
  betId: ulid.optional(),
};

export const errorMessage = z.discriminatedUnion('class', [
  z.object({ ...errorFields, class: z.literal('PLAYER'), code: z.enum(ERROR_CODES.PLAYER) }),
  z.object({ ...errorFields, class: z.literal('SESSION'), code: z.enum(ERROR_CODES.SESSION) }),
  z.object({ ...errorFields, class: z.literal('SYSTEM'), code: z.enum(ERROR_CODES.SYSTEM) }),
]);

export type ErrorMessage = z.infer<typeof errorMessage>;

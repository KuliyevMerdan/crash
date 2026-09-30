// FIXTURE — must NOT be flagged: the engine's whole allow-list, through entry points.
import { schema } from '@crash/protocol';
import { minor } from '@crash/money';
import { m } from '@crash/curve';
import { crashPoint } from '@crash/fair';

export const ok = [schema, minor, m, crashPoint];

// FIXTURE — must NOT be flagged: the web shell's whole allow-list.
import { connect } from '@crash/client-core';
import { draw } from '@crash/renderer';
import { schema } from '@crash/protocol';
import { minor } from '@crash/money';
import { verify } from '@crash/fair';

export const ok = [connect, draw, schema, minor, verify];

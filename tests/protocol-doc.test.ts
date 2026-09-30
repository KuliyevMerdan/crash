import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CLIENT_MESSAGE_TYPES,
  DEV_MESSAGE_TYPES,
  ERROR_CODES,
  SERVER_MESSAGE_TYPES,
} from '@crash/protocol';
import { describe, expect, it } from 'vitest';
import { ROOT } from './lint-runner.js';

/**
 * "The protocol document and `packages/protocol` change together, in one commit, always"
 * (CLAUDE.md). This is the part of that rule a machine can check: the message table in §2 and the
 * error table in §6 name exactly what the schemas accept.
 */
const doc = readFileSync(path.join(ROOT, 'docs/protocol.md'), 'utf8');

function section(heading: string, next: string): string {
  const start = doc.indexOf(heading);
  const end = doc.indexOf(next, start + heading.length);
  if (start < 0 || end < 0) throw new Error(`protocol.md has no section "${heading}"`);
  return doc.slice(start, end);
}

/** Every `| \`name\` … | c→s / s→c / c↔s |` row of the §2 table, split by direction. */
function documentedTypes(): { client: string[]; server: string[] } {
  const client: string[] = [];
  const server: string[] = [];
  for (const line of section('## 2. Messages', '### 2.1').split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const direction = cells[2];
    if (direction === undefined || !/^c[→↔]s|^s→c/.test(direction)) continue;
    const names = [...(cells[1] ?? '').matchAll(/`(\w+)`/g)].map((m) => m[1] ?? '');
    for (const name of names) {
      if (direction === 'c→s') client.push(name);
      else if (direction === 's→c') server.push(name);
      else if (name === 'ping') client.push(name);
      else server.push(name);
    }
  }
  return { client, server };
}

describe('docs/protocol.md and @crash/protocol name the same contract', () => {
  const { client, server } = documentedTypes();

  it('documents every client message the schemas accept, and no other', () => {
    expect(client.sort()).toEqual([...CLIENT_MESSAGE_TYPES].sort());
  });

  it('documents every server message the schemas accept, and no other', () => {
    expect(server.sort()).toEqual([...SERVER_MESSAGE_TYPES].sort());
  });

  it('lists exactly the dev messages in §9', () => {
    const rows = section('## 9. Environment', '## 10.')
      .split('\n')
      .filter((line) => line.startsWith('| `dev'));
    const names = rows.map((line) => /`(\w+)`/.exec(line)?.[1]);
    expect(names.sort()).toEqual([...DEV_MESSAGE_TYPES].sort());
  });

  it.each(['PLAYER', 'SESSION', 'SYSTEM'] as const)('lists exactly the %s codes in §6', (cls) => {
    const row = section('## 6. Errors', '## 7.')
      .split('\n')
      .find((line) => line.startsWith(`| \`${cls}\``));
    const codes = [...(row ?? '').split('|')[2]!.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]);
    expect(codes.sort()).toEqual([...ERROR_CODES[cls]].sort());
  });
});

import { describe, expect, it } from 'vitest';
import { parseRoundRef, parseRoute, verifyHref } from './route.js';

describe('parseRoute', () => {
  it.each([
    ['', { page: 'game' }],
    ['#', { page: 'game' }],
    ['#/play', { page: 'game' }],
    ['#/verify', { page: 'verify', link: null }],
    ['#/verify/1/84213', { page: 'verify', link: { chainId: 1, chainIndex: 84213 } }],
    ['#verify/2/7', { page: 'verify', link: { chainId: 2, chainIndex: 7 } }],
    ['#/verify/1/0', { page: 'verify', link: null }],
    ['#/verify/1/-3', { page: 'verify', link: null }],
    ['#/verify/x/3', { page: 'verify', link: null }],
    ['#/verify/1/2/3', { page: 'verify', link: null }],
    ['#/verify/1/99999999999999999999', { page: 'verify', link: null }],
  ])('%j', (hash, route) => expect(parseRoute(hash)).toEqual(route));

  it('round-trips a link through its href', () => {
    const link = { chainId: 3, chainIndex: 999_999 };
    expect(parseRoute(verifyHref(link))).toEqual({ page: 'verify', link });
  });
});

describe('parseRoundRef — what a stranger pastes', () => {
  it.each([
    ['84213', 1, { chainId: 1, chainIndex: 84213 }],
    [' #84213 ', 1, { chainId: 1, chainIndex: 84213 }],
    ['2:15', 1, { chainId: 2, chainIndex: 15 }],
    ['2 / 15', null, { chainId: 2, chainIndex: 15 }],
    ['https://crash.example/#/verify/1/42', null, { chainId: 1, chainIndex: 42 }],
    ['84213', null, null],
    ['0', 1, null],
    ['1.5', 1, null],
    ['seed', 1, null],
    ['', 1, null],
  ])('%j on chain %j', (text, chain, link) => expect(parseRoundRef(text, chain)).toEqual(link));
});

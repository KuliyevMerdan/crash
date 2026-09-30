import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, hmacSha256, sha256, utf8 } from './index.js';

const ascii = (text: string) => utf8(text);
const hex = (bytes: Uint8Array) => bytesToHex(bytes);

describe('sha256 — FIPS 180-4 vectors and the padding boundaries', () => {
  it.each([
    ['the empty string', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['"abc"', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'the 448-bit message',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      '55 bytes (one block)',
      'a'.repeat(55),
      '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    ],
    [
      '56 bytes (spills a block)',
      'a'.repeat(56),
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    ],
    [
      '64 bytes (exactly a block)',
      'a'.repeat(64),
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    ],
    [
      'multi-byte UTF-8',
      'Крэш ✓ 😀',
      '23a7f435f99d8248c702e4b366626e6b552c12b520c9df5afb5be0e6c9105927',
    ],
  ])('hashes %s', (_label, input, expected) => {
    expect(hex(sha256(ascii(input)))).toBe(expected);
  });

  it('hashes a million "a"s', () => {
    expect(hex(sha256(new Uint8Array(1_000_000).fill(0x61)))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });
});

describe('hmacSha256 — RFC 4231', () => {
  it.each([
    [
      'case 1',
      new Uint8Array(20).fill(0x0b),
      'Hi There',
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    ],
    [
      'case 2',
      ascii('Jefe'),
      'what do ya want for nothing?',
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    ],
    [
      'case 6 (key longer than a block)',
      new Uint8Array(131).fill(0xaa),
      'Test Using Larger Than Block-Size Key - Hash Key First',
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    ],
    [
      'case 7 (key and data longer than a block)',
      new Uint8Array(131).fill(0xaa),
      'This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.',
      '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
    ],
  ])('%s', (_label, key, message, expected) => {
    expect(hex(hmacSha256(key, ascii(message)))).toBe(expected);
  });
});

describe('hex', () => {
  it('round-trips bytes', () => {
    const bytes = Uint8Array.from([0, 1, 15, 16, 127, 128, 255]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
    expect(bytesToHex(bytes)).toBe('00010f107f80ff');
  });

  it.each(['abc', 'ABCD', '0g', 'zz'])('refuses %j', (input) => {
    expect(() => hexToBytes(input)).toThrow(RangeError);
  });
});

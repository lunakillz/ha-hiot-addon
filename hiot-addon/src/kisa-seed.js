/**
 * KISA SEED-128-ECB helper matching hea.iot.smarthome.app.hillstate.common.security.KISA_SEED_ECB.
 *
 * In Hi-oT Smart Home v1.0.101, KISA_SEED_ECB.r(str) is used in Settings.<clinit> and
 * Settings$HCard.<clinit> to decode obfuscated server host constants at startup:
 *   - First character ('A'..'J') selects key index idx = charCode - 65
 *   - 16-byte UTF-8 key = `Hdaut0Everh1@TO${idx}`
 *   - Remaining substring is Base64-encoded SEED-128-ECB ciphertext (big-endian words, PKCS#7 padding)
 */

const SBOXES_LE_B64 =
  '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';

const sboxBuf = Buffer.from(SBOXES_LE_B64, 'base64');
const SS = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
for (let s = 0; s < 4; s++) {
  for (let i = 0; i < 256; i++) {
    SS[s][i] = sboxBuf.readUInt32LE((s * 256 + i) * 4);
  }
}

const KC = new Uint32Array(16);
for (let i = 0; i < 16; i++) {
  KC[i] = i === 0 ? 0x9e3779b9 : ((0x9e3779b9 << i) | (0x9e3779b9 >>> (32 - i))) >>> 0;
}

function gFunc(x) {
  return (
    (SS[0][x & 0xff] ^
      SS[1][(x >>> 8) & 0xff] ^
      SS[2][(x >>> 16) & 0xff] ^
      SS[3][(x >>> 24) & 0xff]) >>>
    0
  );
}

function fFunc(r0, r1, k0, k1) {
  let t0 = (r0 ^ k0) >>> 0;
  let t1 = ((r1 ^ k1) ^ t0) >>> 0;
  t1 = gFunc(t1);
  t0 = (t0 + t1) >>> 0;
  t0 = gFunc(t0);
  t1 = (t1 + t0) >>> 0;
  t1 = gFunc(t1);
  t0 = (t0 + t1) >>> 0;
  return [t0, t1];
}

/**
 * Derive 32 32-bit round keys from a 16-byte SEED-128 user key (big-endian word order).
 * @param {Buffer|Uint8Array} keyBytes
 * @returns {Uint32Array}
 */
export function deriveSeedRoundKeys(keyBytes) {
  const key = Buffer.from(keyBytes);
  if (key.length < 16) {
    throw new RangeError('SEED-128 key must be at least 16 bytes');
  }
  let a = key.readUInt32BE(0);
  let b = key.readUInt32BE(4);
  let c = key.readUInt32BE(8);
  let d = key.readUInt32BE(12);
  const rk = new Uint32Array(32);

  for (let i = 0; i < 16; i++) {
    rk[2 * i] = gFunc((a + c - KC[i]) >>> 0);
    rk[2 * i + 1] = gFunc((b - d + KC[i]) >>> 0);
    if (i % 2 === 0) {
      const t0 = a;
      a = ((a >>> 8) | (b << 24)) >>> 0;
      b = ((b >>> 8) | (t0 << 24)) >>> 0;
    } else {
      const t0 = c;
      c = ((c << 8) | (d >>> 24)) >>> 0;
      d = ((d << 8) | (t0 >>> 24)) >>> 0;
    }
  }
  return rk;
}

export function decryptSeedBlock(block16, rk) {
  let l0 = block16.readUInt32BE(0);
  let l1 = block16.readUInt32BE(4);
  let r0 = block16.readUInt32BE(8);
  let r1 = block16.readUInt32BE(12);

  for (let i = 15; i >= 0; i--) {
    const [t0, t1] = fFunc(r0, r1, rk[2 * i], rk[2 * i + 1]);
    const nextR0 = (l0 ^ t0) >>> 0;
    const nextR1 = (l1 ^ t1) >>> 0;
    l0 = r0;
    l1 = r1;
    r0 = nextR0;
    r1 = nextR1;
  }

  const out = Buffer.allocUnsafe(16);
  out.writeUInt32BE(r0, 0);
  out.writeUInt32BE(r1, 4);
  out.writeUInt32BE(l0, 8);
  out.writeUInt32BE(l1, 12);
  return out;
}

export function encryptSeedBlock(block16, rk) {
  let l0 = block16.readUInt32BE(0);
  let l1 = block16.readUInt32BE(4);
  let r0 = block16.readUInt32BE(8);
  let r1 = block16.readUInt32BE(12);

  for (let i = 0; i < 16; i++) {
    const [t0, t1] = fFunc(r0, r1, rk[2 * i], rk[2 * i + 1]);
    const nextR0 = (l0 ^ t0) >>> 0;
    const nextR1 = (l1 ^ t1) >>> 0;
    l0 = r0;
    l1 = r1;
    r0 = nextR0;
    r1 = nextR1;
  }

  const out = Buffer.allocUnsafe(16);
  out.writeUInt32BE(r0, 0);
  out.writeUInt32BE(r1, 4);
  out.writeUInt32BE(l0, 8);
  out.writeUInt32BE(l1, 12);
  return out;
}

/**
 * Decrypt an APK obfuscated string using KISA_SEED_ECB.r(encoded).
 * @param {string} encoded
 * @returns {string}
 */
export function decryptHiotSeedString(encoded) {
  if (typeof encoded !== 'string' || encoded.length < 2) {
    throw new TypeError('Expected non-empty Hi-oT SEED string');
  }
  const keyIndex = encoded.charCodeAt(0) - 65;
  if (keyIndex < 0 || keyIndex > 9) {
    throw new RangeError(`Unsupported Hi-oT key prefix '${encoded[0]}'`);
  }
  const key = Buffer.from(`Hdaut0Everh1@TO${keyIndex}`, 'utf8');
  const rk = deriveSeedRoundKeys(key);
  const ciphertext = Buffer.from(encoded.slice(1), 'base64');
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new RangeError(`Invalid SEED-ECB ciphertext length (${ciphertext.length})`);
  }

  const chunks = [];
  for (let offset = 0; offset < ciphertext.length; offset += 16) {
    chunks.push(decryptSeedBlock(ciphertext.subarray(offset, offset + 16), rk));
  }
  const plainPadded = Buffer.concat(chunks);
  const padLen = plainPadded[plainPadded.length - 1];
  if (padLen >= 1 && padLen <= 16) {
    let validPad = true;
    for (let i = plainPadded.length - padLen; i < plainPadded.length; i++) {
      if (plainPadded[i] !== padLen) {
        validPad = false;
        break;
      }
    }
    if (validPad) {
      return plainPadded.subarray(0, plainPadded.length - padLen).toString('utf8');
    }
  }
  return plainPadded.toString('utf8');
}

/**
 * Encrypt a UTF-8 string into the same format consumed by KISA_SEED_ECB.r(encoded).
 * @param {string} plaintext
 * @param {number} [keyIndex=6]
 * @returns {string}
 */
export function encryptHiotSeedString(plaintext, keyIndex = 6) {
  if (keyIndex < 0 || keyIndex > 9) {
    throw new RangeError('keyIndex must be between 0 and 9');
  }
  const key = Buffer.from(`Hdaut0Everh1@TO${keyIndex}`, 'utf8');
  const rk = deriveSeedRoundKeys(key);
  const raw = Buffer.from(plaintext, 'utf8');
  const padLen = 16 - (raw.length % 16);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);

  const chunks = [];
  for (let offset = 0; offset < padded.length; offset += 16) {
    chunks.push(encryptSeedBlock(padded.subarray(offset, offset + 16), rk));
  }
  return String.fromCharCode(65 + keyIndex) + Buffer.concat(chunks).toString('base64');
}

/**
 * Encrypted server host constants extracted from Settings.<clinit> & Settings$HCard.<clinit> in classes3.dex.
 */
export const ENCRYPTED_APP_CONSTANTS = Object.freeze({
  SERVER_CONTEXT: 'Gf8COSmt061i2XhhMMZYR8eF0ymwlxcP+1Wqyfzih82u5bP9WiSKJ5noj2C3qknK0',
  DEV_H_SERVER_CONTEXT: 'EtnSXXQ4ALdgHjMreHsVfjnLzqagD9zxrrIZIZvwl7H4AKMeWNczjTgr/zTNB1IvL',
  REAL_VOICE_HOME_SERVER_CONTEXT: 'Fgd2Ap07luO9LnmRH+jc0UajAMRHhiq1CEmOsVBZPzMM=',
  REAL_DEVICE_AUTH_HOST: 'Bxdhxna/9KK2566etlUH9vqHxz9PKe7kpVTImpqSGmMA=',
  REAL_DEVICE_AUTH_HOST2: 'IfCih47EyOMIpB8tBjbZzlLWc9k+ZBzIdAs5hHjf37Qc=',
  REAL_DEVICE_AUTH_HOST3: 'CX0rYWIIkM7BhmPXNokMTqYV/gAIeMbC9fdYTTSB8Y6w=',
  REAL_DEVICE_AUTH_HOST4: 'E+9YMhdkaI8q8wTxXapTMDXyVmHMoasaLGsoRwXWdtas=',
  DEV_H_CARD_DOMAIN: 'EHGY+FNXQFso2du8jykNydX3F/2lZw7ALzL3K8JhUk5g=',
  REAL_H_CARD_DOMAIN: 'GQfJcqMrAHxSfycZ0jAxpMsnyI4ydJLhAnYLZKHsGMk4=',
});

import { signal } from "@preact/signals";

export const encryptionPassphrase = signal("");

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64ToBytes = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const concatenate = (...parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

// CryptoJS passphrase-mode AES uses OpenSSL's salted format and EVP_BytesToKey
// with MD5. WebCrypto intentionally omits MD5, so this small compatibility
// implementation exists only to decrypt already-imported legacy ciphertext.
const md5 = (input: Uint8Array): Uint8Array => {
  const length = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(length);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const bitLength = input.length * 8;
  view.setUint32(length - 8, bitLength >>> 0, true);
  view.setUint32(length - 4, Math.floor(bitLength / 0x1_0000_0000), true);
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let offset = 0; offset < length; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let mixed: number;
      let wordIndex: number;
      if (index < 16) {
        mixed = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        mixed = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        mixed = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }
      const sum = (a + mixed + Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000) + view.getUint32(offset + wordIndex * 4, true)) >>> 0;
      const shift = shifts[Math.floor(index / 16) * 4 + (index % 4)] as number;
      const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0;
      [a, d, c, b] = [d, c, b, (b + rotated) >>> 0];
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const output = new Uint8Array(16);
  const outputView = new DataView(output.buffer);
  [a0, b0, c0, d0].forEach((value, index) => outputView.setUint32(index * 4, value, true));
  return output;
};

export async function decryptLegacyValue(payload: string, passphrase: string): Promise<string> {
  const envelope = base64ToBytes(payload);
  if (new TextDecoder().decode(envelope.slice(0, 8)) !== "Salted__" || envelope.length <= 16) {
    throw new Error("Unsupported legacy encrypted task format");
  }
  const salt = envelope.slice(8, 16);
  const password = new TextEncoder().encode(passphrase);
  let derived: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let block: Uint8Array<ArrayBufferLike> = new Uint8Array();
  while (derived.length < 48) {
    block = md5(concatenate(block, password, salt));
    derived = concatenate(derived, block);
  }
  const key = await crypto.subtle.importKey("raw", buffer(derived.slice(0, 32)), { name: "AES-CBC" }, false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: buffer(derived.slice(32, 48)) },
    key,
    buffer(envelope.slice(16))
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
}

const deriveKey = async (passphrase: string, salt: Uint8Array) => {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", iterations: 210_000, salt: buffer(salt) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
};

export async function encryptValue(value: string, passphrase: string) {
  if (passphrase.length < 12) throw new Error("Encryption passphrase must be at least 12 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(iv) }, key, new TextEncoder().encode(value))
  );
  const keyHash = new Uint8Array(await crypto.subtle.digest("SHA-256", salt));
  return {
    payload: `v1:${bytesToBase64(salt)}:${bytesToBase64(iv)}:${bytesToBase64(encrypted)}`,
    keyId: bytesToBase64(keyHash.slice(0, 9))
  };
}

export async function decryptValue(payload: string, passphrase: string): Promise<string> {
  const [version, saltValue, ivValue, encryptedValue] = payload.split(":");
  if (version !== "v1" || !saltValue || !ivValue || !encryptedValue) {
    throw new Error("Unsupported encrypted task format");
  }
  const salt = base64ToBytes(saltValue);
  const key = await deriveKey(passphrase, salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buffer(base64ToBytes(ivValue)) },
    key,
    buffer(base64ToBytes(encryptedValue))
  );
  return new TextDecoder().decode(decrypted);
}

export const decryptTaskValue = (payload: string, passphrase: string, algorithm: string): Promise<string> =>
  algorithm === "legacy-aes" ? decryptLegacyValue(payload, passphrase) : decryptValue(payload, passphrase);

export async function encryptTaskFields(text: string, note: string, passphrase: string) {
  const [encryptedText, encryptedNote] = await Promise.all([
    encryptValue(text, passphrase),
    encryptValue(note, passphrase)
  ]);
  return {
    text: encryptedText.payload,
    note: encryptedNote.payload,
    encryption: { algorithm: "AES-256-GCM/PBKDF2-SHA256", keyId: encryptedText.keyId }
  };
}

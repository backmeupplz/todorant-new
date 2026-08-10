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

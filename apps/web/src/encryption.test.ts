import { describe, expect, it } from "vitest";
import { decryptLegacyValue, decryptValue, encryptTaskFields } from "./encryption.js";

describe("client-side task encryption", () => {
  it("round-trips AES-GCM ciphertext without exposing plaintext to storage", async () => {
    const encrypted = await encryptTaskFields("Private task", "Private note", "long local passphrase");
    expect(encrypted.encryption.algorithm).toBe("AES-256-GCM/PBKDF2-SHA256");
    expect(encrypted.text).not.toContain("Private task");
    expect(encrypted.note).not.toContain("Private note");
    await expect(decryptValue(encrypted.text, "long local passphrase")).resolves.toBe("Private task");
    await expect(decryptValue(encrypted.note, "wrong local passphrase")).rejects.toThrow();
  });

  it("decrypts the OpenSSL salted AES format used by legacy CryptoJS", async () => {
    const legacy = "U2FsdGVkX18Fujot+mRv0TMn9/5ydjXVKKbmADv4JCbwc/LxYKUK6q/9uCcBYkny";
    await expect(decryptLegacyValue(legacy, "correct horse battery staple")).resolves.toBe("Legacy private task");
    await expect(decryptLegacyValue(legacy, "wrong password")).rejects.toThrow();
  });
});

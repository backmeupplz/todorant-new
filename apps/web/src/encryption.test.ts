import { describe, expect, it } from "vitest";
import { decryptValue, encryptTaskFields } from "./encryption.js";

describe("client-side task encryption", () => {
  it("round-trips AES-GCM ciphertext without exposing plaintext to storage", async () => {
    const encrypted = await encryptTaskFields("Private task", "Private note", "long local passphrase");
    expect(encrypted.encryption.algorithm).toBe("AES-256-GCM/PBKDF2-SHA256");
    expect(encrypted.text).not.toContain("Private task");
    expect(encrypted.note).not.toContain("Private note");
    await expect(decryptValue(encrypted.text, "long local passphrase")).resolves.toBe("Private task");
    await expect(decryptValue(encrypted.note, "wrong local passphrase")).rejects.toThrow();
  });
});

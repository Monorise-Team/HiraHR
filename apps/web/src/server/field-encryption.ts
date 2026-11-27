import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApiFailure } from "./api";
import { config } from "./config";

/**
 * Szyfrowanie pól wrażliwych HiraHR (ADR-0104): AES-256-GCM z losowym 12-bajtowym IV i danymi
 * dodatkowymi (AAD) wiążącymi szyfrogram z firmą, rekordem i polem. Szyfrogramu PESEL-u jednej osoby
 * nie da się więc przenieść do innej osoby ani innego pola: odszyfrowanie się nie powiedzie.
 *
 * Format zapisu: `v1.<idKlucza>.<iv>.<szyfrogram>.<znacznik>` (base64url). Klucze z `HIRAHR_FIELD_ENCRYPTION_KEYS`
 * (`id:base64`, pierwszy szyfruje, wszystkie odszyfrowują), co pozwala wymienić klucz bez przestoju.
 */

const VERSION = "v1";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export const ENCRYPTION_NOT_CONFIGURED_MESSAGE = "Szyfrowanie danych wrażliwych nie jest skonfigurowane";

export interface FieldKeyring {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

/** Odczytuje klucze z napisu `id:base64,id:base64`; błędny wpis kończy się wyjątkiem (bez treści klucza). */
export function parseKeyring(entries: readonly string[]): FieldKeyring | null {
  if (entries.length === 0) return null;
  const keys = new Map<string, Buffer>();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    const id = separator > 0 ? entry.slice(0, separator) : "";
    const material = separator > 0 ? Buffer.from(entry.slice(separator + 1), "base64") : Buffer.alloc(0);
    if (!KEY_ID_PATTERN.test(id) || material.length !== 32) {
      throw new Error(`Niepoprawny wpis klucza szyfrującego „${id || "?"}”: oczekiwano id:base64 z 32 bajtami`);
    }
    if (keys.has(id)) {
      throw new Error(`Powtórzony identyfikator klucza szyfrującego „${id}”`);
    }
    keys.set(id, material);
  }
  return { activeKeyId: entries[0]!.slice(0, entries[0]!.indexOf(":")), keys };
}

function keyring(): FieldKeyring {
  let parsed: FieldKeyring | null;
  try {
    parsed = parseKeyring(config.fieldEncryptionKeys);
  } catch (error) {
    console.error(`[hirahr.encryption] ${error instanceof Error ? error.message : "Błąd konfiguracji kluczy"}`);
    throw new ApiFailure(503, "INTERNAL_ERROR", ENCRYPTION_NOT_CONFIGURED_MESSAGE);
  }
  if (!parsed) {
    console.error("[hirahr.encryption] Brak HIRAHR_FIELD_ENCRYPTION_KEYS");
    throw new ApiFailure(503, "INTERNAL_ERROR", ENCRYPTION_NOT_CONFIGURED_MESSAGE);
  }
  return parsed;
}

/** Dane dodatkowe AAD: firma, rekord i nazwa pola. */
export interface FieldContext {
  readonly organizationId: string;
  readonly recordId: string;
  readonly field: string;
}

function aad(context: FieldContext): Buffer {
  return Buffer.from(`hirahr:${context.organizationId}:${context.recordId}:${context.field}`, "utf8");
}

export function encryptWith(ring: FieldKeyring, plaintext: string, context: FieldContext): string {
  const key = ring.keys.get(ring.activeKeyId)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    ring.activeKeyId,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function decryptWith(ring: FieldKeyring, stored: string, context: FieldContext): string {
  const parts = stored.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error("Nieznany format szyfrogramu");
  }
  const [, keyId, ivText, ciphertextText, tagText] = parts as [string, string, string, string, string];
  const key = ring.keys.get(keyId);
  if (!key) {
    throw new Error(`Brak klucza „${keyId}” do odszyfrowania`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}

/** Szyfruje wartość aktywnym kluczem (`503`, gdy klucze nie są skonfigurowane). */
export function encryptField(plaintext: string, context: FieldContext): string {
  return encryptWith(keyring(), plaintext, context);
}

/**
 * Odszyfrowuje wartość. Uszkodzony albo podmieniony szyfrogram kończy się `500` z wpisem w logu
 * (bez wartości i bez treści klucza), żeby nigdy nie zwrócić cudzych danych.
 */
export function decryptField(stored: string, context: FieldContext): string {
  const ring = keyring();
  try {
    return decryptWith(ring, stored, context);
  } catch (error) {
    console.error(
      `[hirahr.encryption] Nie udało się odszyfrować pola ${context.field} (${error instanceof Error ? error.message : "błąd"})`,
    );
    throw new ApiFailure(500, "INTERNAL_ERROR", "Nie udało się odczytać danych wrażliwych");
  }
}

/** Nowy losowy klucz w formacie wpisu `id:base64` (do `pnpm setup:env` i testów). */
export function generateKeyEntry(id: string): string {
  return `${id}:${randomBytes(32).toString("base64")}`;
}

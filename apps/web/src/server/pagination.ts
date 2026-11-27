import "server-only";
import type { PaginatedResult } from "@hirahr/contracts";
import { ApiFailure } from "./api";

/** Kursor przesunięcia (`{ o }` w base64url) dla list liczonych w pamięci albo krótkich katalogów. */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

export function decodeOffsetCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
    if (typeof value.o === "number" && Number.isSafeInteger(value.o) && value.o >= 0) return value.o;
  } catch {
    // niżej wspólny błąd
  }
  throw new ApiFailure(422, "VALIDATION_FAILED", "Niepoprawny kursor stronicowania", [
    { field: "cursor", message: "Niepoprawny kursor" },
  ]);
}

/** Strona listy od przesunięcia z kursora. */
export function pageByOffset<T>(items: readonly T[], cursor: string | undefined, limit: number): PaginatedResult<T> {
  const offset = decodeOffsetCursor(cursor);
  const page = items.slice(offset, offset + limit);
  return { items: page, nextCursor: offset + limit < items.length ? encodeOffsetCursor(offset + limit) : null };
}

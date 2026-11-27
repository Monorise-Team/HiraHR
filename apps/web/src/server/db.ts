import "server-only";
import { createDb, type PrismaClient } from "@hirahr/db";
import { config } from "./config";

const globalForDb = globalThis as unknown as { hirahrDb?: PrismaClient };

/**
 * Baza hira_hr (PostgreSQL, ADR-0096, ADR-0104). Serwer łączy się rolą hira_hr_app, więc tabele
 * domenowe z RLS są dostępne wyłącznie przez withUser z @hirahr/db (ADR-0037). Jedna pula połączeń
 * na proces, także po przeładowaniu modułów w trybie deweloperskim.
 */
export function getDb(): PrismaClient {
  if (!config.databaseUrl) throw new Error("Brak DATABASE_URL (lokalnie: pnpm setup:env, pnpm db:up, pnpm db:migrate)");
  globalForDb.hirahrDb ??= createDb(config.databaseUrl);
  return globalForDb.hirahrDb;
}

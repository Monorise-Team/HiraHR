import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Moduły tylko dla serwera: w testach nie ma podziału na klienta i serwer
      "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    env: {
      // Prawdziwy PostgreSQL (pnpm db:up && pnpm db:migrate albo usługa w CI), rola aplikacji z RLS
      DATABASE_URL:
        process.env.HIRAHR_TEST_APP_DATABASE_URL ?? "postgresql://hira_hr_app:hira_hr_app@localhost:5437/hira_hr_test",
      HIRAHR_SESSION_SECRET: "sekret-sesji-tylko-do-testow-ma-ponad-32-znaki",
      HIRAHR_OAUTH_CLIENT_SECRET: "sekret-klienta-tylko-do-testow",
    },
  },
});

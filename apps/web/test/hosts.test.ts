import { describe, expect, it } from "vitest";
import { appHosts, hostname, routeFor } from "@/lib/hosts";

const HOSTS = appHosts(undefined);

describe("dwa adresy z jednej aplikacji", () => {
  it("hirahr. pokazuje aplikację: ścieżki przepisuje na /app", () => {
    expect(routeFor("hirahr.monorise.studio", "/", HOSTS)).toEqual({ kind: "rewrite", pathname: "/app" });
    expect(routeFor("hirahr.localhost", "/issues", HOSTS)).toEqual({ kind: "rewrite", pathname: "/app/issues" });
  });

  it("hira. pokazuje stronę produktu, a ścieżki /app dają tam 404", () => {
    expect(routeFor("hira.monorise.studio", "/", HOSTS)).toEqual({ kind: "next" });
    expect(routeFor("hira.monorise.studio", "/app", HOSTS)).toEqual({ kind: "not-found" });
    expect(routeFor("localhost", "/app/issues", HOSTS)).toEqual({ kind: "not-found" });
  });

  it("czyta nazwę hosta bez portu", () => {
    expect(hostname("HiraHR.localhost:3600")).toBe("hirahr.localhost");
    expect(hostname(null)).toBe("");
  });

  it("lista adresów aplikacji z HIRAHR_APP_HOSTS", () => {
    expect(appHosts("zadania.example.test, App.Example.test")).toEqual(["zadania.example.test", "app.example.test"]);
  });
});

"use client";

import { ApiError, createClient, type Me, type Unit } from "@hirahr/client";
import { ThemeProvider, ToastProvider } from "@monorise-team/ui";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppearanceView } from "./AppearanceView";
import { HiraHRShell } from "./HiraHRShell";
import { LeaveView } from "./components/LeaveView";
import { PeopleView } from "./components/PeopleView";
import { PersonView } from "./components/PersonView";
import { PositionsView } from "./components/PositionsView";
import { LoadErrorView, LoadingView, NoAccessView, SignedOutView } from "./SignedOutView";
import {
  AUTH_ERROR_MESSAGES,
  VIEW_HASHES,
  parseRouteFromHash,
  resolveAccessDenialMessage,
  type AppView,
} from "./app-views";

function subscribeHash(onStoreChange: () => void): () => void {
  window.addEventListener("hashchange", onStoreChange);
  window.addEventListener("popstate", onStoreChange);
  return () => {
    window.removeEventListener("hashchange", onStoreChange);
    window.removeEventListener("popstate", onStoreChange);
  };
}

function getHashSnapshot(): string {
  return window.location.hash;
}

function getServerHashSnapshot(): string {
  return "";
}

/** Aplikacja HiraHR w przeglądarce: sesja BFF w ciasteczku HttpOnly i wspólne API `/api/v1`. */
export function HiraHRApp() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <HiraHRContent />
      </ToastProvider>
    </ThemeProvider>
  );
}

function HiraHRContent() {
  const client = useMemo(() => createClient(), []);
  const hash = useSyncExternalStore(subscribeHash, getHashSnapshot, getServerHashSnapshot);

  const [me, setMe] = useState<Me | null>(null);
  const [authState, setAuthState] = useState<"loading" | "signed-out" | "signed-in" | "error">("loading");
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const reload = useCallback(async () => {
    setAuthState("loading");
    setAuthError(null);
    try {
      const profile = await client.session.me();
      setMe(profile);
      setAuthState("signed-in");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setMe(null);
        setAuthState("signed-out");
        return;
      }
      setAuthError(error instanceof Error ? error.message : "Nie udało się połączyć z serwerem HiraHR.");
      setAuthState("error");
    }
  }, [client]);

  const handleRefresh = useCallback(async () => {
    setActionError(null);
    try {
      const profile = await client.session.me();
      setMe(profile);
      setRefreshKey((key) => key + 1);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setMe(null);
        setAuthState("signed-out");
        return;
      }
      setActionError(error instanceof Error ? error.message : "Nie udało się odświeżyć danych.");
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    const reason = new URLSearchParams(window.location.search).get("auth_error");
    client.session.me().then(
      (profile) => {
        if (cancelled) return;
        setMe(profile);
        setAuthState("signed-in");
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          setMe(null);
          if (reason) {
            setAuthError(AUTH_ERROR_MESSAGES[reason] ?? AUTH_ERROR_MESSAGES.failed ?? "Nie udało się zalogować.");
          }
          setAuthState("signed-out");
          return;
        }
        setAuthError(error instanceof Error ? error.message : "Nie udało się połączyć z serwerem HiraHR.");
        setAuthState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Nazwy jednostek do filtrów i kart (best-effort: bez nich widać same identyfikatory)
  useEffect(() => {
    if (authState !== "signed-in") return;
    let cancelled = false;
    client.units.list({ limit: 100 }).then(
      (page) => {
        if (!cancelled) setUnits(page.items);
      },
      () => {
        if (!cancelled) setUnits([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [authState, client]);

  const handleSignOut = useCallback(async () => {
    setBusy(true);
    try {
      await client.session.signOut();
      setMe(null);
      setActionError(null);
      setAuthState("signed-out");
    } finally {
      setBusy(false);
    }
  }, [client]);

  const navigateTo = useCallback((view: AppView) => {
    const nextHash = VIEW_HASHES[view];
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }, []);

  const dismissActionError = useCallback(() => {
    setActionError(null);
  }, []);

  const handleRefreshClick = useCallback(() => {
    void handleRefresh();
  }, [handleRefresh]);

  const handleSignOutClick = useCallback(() => {
    void handleSignOut();
  }, [handleSignOut]);

  if (authState === "loading") {
    return <LoadingView />;
  }

  if (authState === "signed-out") {
    return <SignedOutView authError={authError} />;
  }

  if (authState === "error" || !me) {
    return <LoadErrorView error={authError} onRetry={() => void reload()} />;
  }

  const accessDenialMessage = resolveAccessDenialMessage(me.capabilities);
  if (accessDenialMessage) {
    return (
      <NoAccessView
        me={me}
        message={accessDenialMessage}
        busy={busy}
        onRetry={() => void reload()}
        onSignOut={() => void handleSignOut()}
      />
    );
  }

  const route = parseRouteFromHash(hash);
  const capabilities = me.capabilities;
  const activeView = route.view;

  let content: ReactNode;
  if (activeView === "appearance") {
    content = <AppearanceView />;
  } else if (activeView === "person" && route.employeeId) {
    content = (
      <PersonView
        key={`${route.employeeId}-${refreshKey}`}
        client={client}
        employeeId={route.employeeId}
        units={units}
        isOwnProfile={route.employeeId === me.employee.id}
      />
    );
  } else if (activeView === "people" && capabilities.readEmployees) {
    content = <PeopleView key={refreshKey} client={client} units={units} />;
  } else if (activeView === "positions" && capabilities.manageSettings) {
    content = <PositionsView key={refreshKey} client={client} />;
  } else if (activeView === "leave") {
    content = (
      <LeaveView
        key={refreshKey}
        client={client}
        employeeId={me.employee.id}
        employeeName={me.employee.fullName}
        capabilities={capabilities}
        units={units}
      />
    );
  } else {
    content = (
      <PersonView key={`me-${refreshKey}`} client={client} employeeId={me.employee.id} units={units} isOwnProfile />
    );
  }

  return (
    <HiraHRShell
      organizationName={me.organization.name}
      personName={me.employee.fullName}
      capabilities={capabilities}
      view={activeView}
      busy={busy}
      actionError={actionError}
      onDismissActionError={dismissActionError}
      onNavigate={navigateTo}
      onRefresh={handleRefreshClick}
      onSignOut={handleSignOutClick}
    >
      {content}
    </HiraHRShell>
  );
}

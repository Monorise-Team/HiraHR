"use client";

import {
  AppShell,
  Banner,
  Card,
  CommandPalette,
  ShortcutsHelp,
  SidebarCollapseButton,
  SidebarItem,
  SidebarLink,
  SidebarNav,
  SidebarShell,
  cn,
  useCommandPalette,
  useHotkeys,
  useSidebar,
  type CommandPaletteGroup,
  type CommandPaletteItem,
  type ShortcutHelpCategory,
} from "@monorise-team/ui";
import type { Capabilities } from "@hirahr/client";
import { Briefcase, CalendarDays, Contact, Keyboard, LogOut, Palette, RefreshCw, UserRound, Users } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { VIEW_HASHES, type AppView } from "./app-views";

export interface HiraHRShellProps {
  organizationName: string;
  personName: string;
  capabilities: Capabilities;
  view: AppView;
  busy: boolean;
  actionError: string | null;
  onDismissActionError: () => void;
  onNavigate: (view: AppView) => void;
  onRefresh: () => void;
  onSignOut: () => void;
  children: ReactNode;
}

/**
 * Szkielet zalogowanej aplikacji HiraHR: tapeta pod szklanymi kartami, zwijany pasek boczny,
 * aktywny widok na karcie do czytania, paleta poleceń (⌘K / Ctrl+K) oraz skróty `g …` i `?`.
 */
export function HiraHRShell({
  organizationName,
  personName,
  capabilities,
  view,
  busy,
  actionError,
  onDismissActionError,
  onNavigate,
  onRefresh,
  onSignOut,
  children,
}: HiraHRShellProps) {
  const palette = useCommandPalette();
  const [helpOpen, setHelpOpen] = useState(false);

  const hotkeys = useMemo(
    () => [
      { shortcut: "g p", handler: () => onNavigate("profile") },
      { shortcut: "g l", handler: () => onNavigate("people") },
      { shortcut: "g u", handler: () => onNavigate("leave") },
      { shortcut: "g w", handler: () => onNavigate("appearance") },
    ],
    [onNavigate],
  );

  useHotkeys(hotkeys, { ignoreWhenModalOpen: true });

  const groups = useMemo<CommandPaletteGroup[]>(() => {
    const goItems: CommandPaletteItem[] = [
      {
        id: "go-profile",
        label: "Mój profil",
        icon: <UserRound size={16} aria-hidden />,
        shortcut: "g p",
        keywords: ["profil", "moje", "dane", "kartoteka", "profile"],
        onSelect: () => onNavigate("profile"),
      },
      {
        id: "go-people",
        label: "Ludzie",
        icon: <Users size={16} aria-hidden />,
        shortcut: "g l",
        keywords: ["ludzie", "pracownicy", "kartoteki", "kadry", "people"],
        onSelect: () => onNavigate("people"),
      },
      ...(capabilities.manageSettings
        ? [
            {
              id: "go-positions",
              label: "Stanowiska",
              icon: <Briefcase size={16} aria-hidden />,
              keywords: ["stanowiska", "ustawienia", "katalog", "positions"],
              onSelect: () => onNavigate("positions"),
            },
          ]
        : []),
      {
        id: "go-leave",
        label: "Urlopy",
        icon: <CalendarDays size={16} aria-hidden />,
        shortcut: "g u",
        keywords: ["urlopy", "nieobecnosci", "wnioski", "kalendarz", "leave"],
        onSelect: () => onNavigate("leave"),
      },
      {
        id: "go-appearance",
        label: "Wygląd",
        icon: <Palette size={16} aria-hidden />,
        shortcut: "g w",
        keywords: ["wyglad", "motyw", "ciemny", "jasny", "tapeta", "ustawienia"],
        onSelect: () => onNavigate("appearance"),
      },
      {
        id: "go-shortcuts",
        label: "Skróty klawiszowe",
        icon: <Keyboard size={16} aria-hidden />,
        shortcut: "shift+?",
        keywords: ["skroty", "klawiatura", "pomoc", "klawisze"],
        onSelect: () => setHelpOpen(true),
      },
    ];

    const actionItems: CommandPaletteItem[] = [
      {
        id: "action-refresh",
        label: "Odśwież",
        icon: <RefreshCw size={16} aria-hidden />,
        keywords: ["odswiez", "pobierz", "aktualizuj", "reload"],
        disabled: busy,
        onSelect: onRefresh,
      },
      {
        id: "action-sign-out",
        label: "Wyloguj",
        icon: <LogOut size={16} aria-hidden />,
        keywords: ["wyloguj", "wyjdz", "sesja", "konto"],
        disabled: busy,
        onSelect: onSignOut,
      },
    ];

    return [
      { id: "go", label: "Przejdź do", items: goItems },
      { id: "actions", label: "Działania", items: actionItems },
    ];
  }, [busy, capabilities.manageSettings, onNavigate, onRefresh, onSignOut]);

  const shortcutCategories = useMemo<ShortcutHelpCategory[]>(
    () => [
      {
        category: "Ogólne",
        items: [
          { label: "Paleta poleceń", shortcut: "mod+k" },
          { label: "Skróty klawiszowe", shortcut: "shift+?" },
        ],
      },
      {
        category: "Przejdź do",
        items: [
          { label: "Mój profil", shortcut: "g p" },
          { label: "Ludzie", shortcut: "g l" },
          { label: "Urlopy", shortcut: "g u" },
          { label: "Wygląd", shortcut: "g w" },
        ],
      },
    ],
    [],
  );

  return (
    <AppShell>
      <SidebarShell
        aria-label="Nawigacja HiraHR"
        footer={<SidebarFooter view={view} busy={busy} onSignOut={onSignOut} />}
      >
        <SidebarHeader organizationName={organizationName} personName={personName} />
        <SidebarNav>
          <SidebarLink
            href={VIEW_HASHES.profile}
            icon={<UserRound aria-hidden />}
            label="Mój profil"
            active={view === "profile"}
          />
          {capabilities.readEmployees ? (
            <SidebarLink
              href={VIEW_HASHES.people}
              icon={<Users aria-hidden />}
              label="Ludzie"
              active={view === "people" || view === "person"}
            />
          ) : null}
          <SidebarLink
            href={VIEW_HASHES.leave}
            icon={<CalendarDays aria-hidden />}
            label="Urlopy"
            active={view === "leave"}
          />
          {capabilities.manageSettings ? (
            <SidebarLink
              href={VIEW_HASHES.positions}
              icon={<Briefcase aria-hidden />}
              label="Stanowiska"
              active={view === "positions"}
            />
          ) : null}
        </SidebarNav>
      </SidebarShell>

      <Card surface="reading" className="min-w-0 flex-1 overflow-y-auto">
        <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
          {actionError ? <Banner tone="danger" message={actionError} onDismiss={onDismissActionError} /> : null}
          {children}
        </main>
      </Card>

      <CommandPalette
        open={palette.open}
        onOpenChange={palette.onOpenChange}
        groups={groups}
        placeholder="Szukaj w HiraHR…"
        emptyText="Nic nie pasuje."
      />
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} bindShortcut categories={shortcutCategories} />
    </AppShell>
  );
}

function SidebarHeader({ organizationName, personName }: { organizationName: string; personName: string }) {
  const { collapsed } = useSidebar();
  if (collapsed) {
    return (
      <div className="flex justify-center pt-3 pb-2" title={`HiraHR · ${organizationName} · ${personName}`}>
        <span className="flex size-8 items-center justify-center rounded-xl bg-accent text-accent-fg">
          <Contact className="size-4" aria-hidden />
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2.5 px-3 pt-3 pb-2">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg">
        <Contact className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium tracking-wide text-text-tertiary uppercase">HiraHR</p>
        <p className="truncate text-sm font-semibold text-text-primary">{organizationName}</p>
        <p className="truncate text-xs text-text-secondary">{personName}</p>
      </div>
    </div>
  );
}

function SidebarFooter({ view, busy, onSignOut }: { view: AppView; busy: boolean; onSignOut: () => void }) {
  const { collapsed } = useSidebar();
  return (
    <div className={cn("flex w-full flex-col gap-1", collapsed && "items-center")}>
      <SidebarLink
        href={VIEW_HASHES.appearance}
        icon={<Palette aria-hidden />}
        label="Wygląd"
        active={view === "appearance"}
      />
      <SidebarItem icon={<LogOut aria-hidden />} label="Wyloguj" onClick={onSignOut} disabled={busy} />
      <SidebarCollapseButton />
    </div>
  );
}

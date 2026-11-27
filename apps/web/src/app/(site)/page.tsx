import { AppBackdrop, Badge, Button, Card } from "@monorise-team/ui";
import { CalendarDays, Contact, FileText, ShieldCheck, Users } from "lucide-react";

const APP_URL = process.env.HIRAHR_APP_URL ?? "https://hirahr.monorise.studio";

const HIGHLIGHTS = [
  {
    icon: <Users />,
    title: "Kartoteka pracowników",
    body: "Dane kadrowe, umowy z historią i stanowiska przy ludziach ze struktury firmy w MonoriseCore, bez wpisywania ich drugi raz.",
  },
  {
    icon: <CalendarDays />,
    title: "Urlopy i nieobecności",
    body: "Salda urlopu według polskich zasad, wnioski z akceptacją kierownika i kalendarz nieobecności zespołu.",
  },
  {
    icon: <FileText />,
    title: "Akta osobowe",
    body: "Dokumenty pracownicze w częściach A–E z terminem przechowywania liczonym od końca zatrudnienia.",
  },
  {
    icon: <ShieldCheck />,
    title: "Dane wrażliwe pod ochroną",
    body: "PESEL, rachunek i wynagrodzenie szyfrowane, widoczne tylko dla kadr w zakresie całej firmy, z dziennikiem każdego dostępu.",
  },
];

export default function ProductPage() {
  return (
    <>
      <AppBackdrop />
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <a href="/" className="flex items-center gap-2 text-sm font-semibold tracking-wide uppercase">
          <span className="mr-glow flex size-8 items-center justify-center rounded-xl bg-accent text-accent-fg">
            <Contact className="size-4" aria-hidden />
          </span>
          HiraHR
        </a>
        <Button asChild variant="primary" size="md" className="rounded-full">
          <a href={APP_URL}>Otwórz HiraHR</a>
        </Button>
      </header>

      <main id="main" className="mx-auto flex max-w-5xl flex-col gap-16 px-6 pt-10 pb-20">
        <section className="mr-enter flex max-w-2xl flex-col gap-5">
          <Badge tone="accent" className="w-fit px-2.5">
            W budowie · Etap 0
          </Badge>
          <h1 className="font-display text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">
            Kadry w przeglądarce, po polsku
          </h1>
          <p className="text-lg leading-relaxed text-text-secondary">
            HiraHR prowadzi kartoteki, urlopy i akta osobowe zgodnie z polskimi realiami i korzysta ze struktury firmy w
            MonoriseCore. Pracownicy sami sprawdzają swoje dane i saldo urlopu. Jedno konto Monorise.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="primary" size="lg" className="rounded-full">
              <a href={APP_URL}>Przejdź do aplikacji</a>
            </Button>
          </div>
        </section>

        <section aria-labelledby="mozliwosci-tytul" className="flex flex-col gap-5">
          <h2 id="mozliwosci-tytul" className="font-display text-2xl font-semibold">
            Dla działu kadr i pracowników
          </h2>
          <div className="grid gap-card sm:grid-cols-2">
            {HIGHLIGHTS.map((item) => (
              <Card key={item.title} surface="reading" className="flex flex-col gap-3 p-6">
                <span className="flex size-10 items-center justify-center rounded-xl bg-accent-light text-accent [&_svg]:size-5">
                  {item.icon}
                </span>
                <h3 className="text-base font-semibold">{item.title}</h3>
                <p className="text-sm leading-relaxed text-text-secondary">{item.body}</p>
              </Card>
            ))}
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-5xl flex-col gap-2 px-6 pb-10 text-sm text-text-tertiary sm:flex-row sm:justify-between">
        <span>© {new Date().getFullYear()} Monorise. HiraHR jest produktem Monorise.</span>
        <a href="https://monorise.studio" className="hover:text-text-primary">
          monorise.studio
        </a>
      </footer>
    </>
  );
}

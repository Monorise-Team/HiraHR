import { ApiError } from "@hirahr/client";

/**
 * Błąd API po polsku dla interfejsu: komunikat serwera, a przy błędnych danych także szczegóły pól.
 * Brak połączenia i nieznane błędy dostają komunikat zapasowy.
 */
export function formatApiError(error: unknown, fallback = "Nie udało się wykonać operacji."): string {
  if (error instanceof ApiError) {
    if (error.status === 422) {
      const details = error.details.map((detail) => detail.message).filter(Boolean);
      if (details.length > 0) return details.join(". ");
    }
    if (error.status === 0) return "Brak połączenia z serwerem HiraHR.";
    return error.message || fallback;
  }
  return fallback;
}

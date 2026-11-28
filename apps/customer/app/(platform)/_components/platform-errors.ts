import { FlashApiError } from "../../../lib/flash-api";

/** Readable Spanish message for a console API error (the throttler answers in English). */
export function platformError(e: unknown): string {
  if (e instanceof FlashApiError && e.status === 429)
    return e.retryAfterSeconds
      ? `Demasiados intentos. Espera ${Math.ceil(e.retryAfterSeconds)} segundos y vuelve a intentarlo una sola vez.`
      : "Demasiados intentos. Espera un minuto y vuelve a intentarlo una sola vez.";
  return e instanceof Error ? e.message : "Ocurrió un error.";
}

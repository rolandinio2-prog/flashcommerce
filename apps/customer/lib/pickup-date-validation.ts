// Same future-date rule as submit/API; existing picker suggestion is unchanged.
export function pickupDateError(value: string, now: number): string | null {
  if (!value.trim()) return "Elige la fecha y hora de retiro.";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "La fecha y hora de retiro no es válida.";
  if (timestamp <= now) return "La fecha y hora de retiro debe ser futura.";
  return null;
}

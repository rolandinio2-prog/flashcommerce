// Contact matching is only an extra check; a phone number is never proof of ownership.
export function recoveryPhone(value: unknown): string {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  return digits.replace(/^(?:00591|591)([67]\d{7})$/, '$1');
}

export function recoveryPhoneAliases(phone: string): string[] {
  const normalized = recoveryPhone(phone);
  return /^[67]\d{7}$/.test(normalized)
    ? [normalized, `591${normalized}`, `00591${normalized}`]
    : [normalized];
}

export function sameRecoveryPhone(left: unknown, right: unknown): boolean {
  const normalized = recoveryPhone(left);
  return normalized.length >= 7 && normalized === recoveryPhone(right);
}

export const RECOVERY_PAGE_SIZE = 50;
export const RECOVERY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

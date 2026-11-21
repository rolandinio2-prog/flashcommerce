// Amounts cross the API boundary as decimal strings, never binary floats.
export function minorUnits(value: unknown): bigint {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)
  ) {
    throw new Error('MONEY_INVALID');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function decimalAmount(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}
export function closingAmounts(
  expected: unknown,
  counted: unknown,
  note: unknown,
) {
  const expectedMinor = minorUnits(expected),
    countedMinor = minorUnits(counted);
  if (
    typeof note !== 'string' ||
    note.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(note)
  )
    throw new Error('NOTE_INVALID');
  const reason = note.trim();
  if (expectedMinor !== countedMinor && reason.length < 5)
    throw new Error('DIFFERENCE_REASON_REQUIRED');
  return {
    expected: decimalAmount(expectedMinor),
    counted: decimalAmount(countedMinor),
    difference: decimalAmount(countedMinor - expectedMinor),
    note: reason,
  };
}

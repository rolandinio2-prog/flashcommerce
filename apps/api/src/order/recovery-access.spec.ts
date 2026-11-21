import {
  RECOVERY_UUID,
  recoveryPhone,
  recoveryPhoneAliases,
  sameRecoveryPhone,
} from './recovery-access';

describe('order recovery phone matching', () => {
  it.each([
    ['71234567', '71234567'],
    ['+591 71234567', '71234567'],
    ['00591-7123-4567', '71234567'],
    ['591 6 123 4567', '61234567'],
    ['(591) 5123-4567', '59151234567'], // only mobile prefixes 6/7 are normalized
    [12345678, ''],
    [null, ''],
  ])('normalizes %j to %j', (input, expected) => {
    expect(recoveryPhone(input)).toBe(expected);
  });

  it('expands Bolivian mobiles to all stored formats', () => {
    expect(recoveryPhoneAliases('+591 71234567')).toEqual([
      '71234567',
      '59171234567',
      '0059171234567',
    ]);
    expect(recoveryPhoneAliases('4-4123456')).toEqual(['44123456']);
  });

  it('matches equivalent formats', () => {
    expect(sameRecoveryPhone('71234567', '+591 7123 4567')).toBe(true);
    expect(sameRecoveryPhone('0059171234567', '71234567')).toBe(true);
  });

  it('does not match different or too-short numbers', () => {
    expect(sameRecoveryPhone('71234567', '71234568')).toBe(false);
    expect(sameRecoveryPhone('123', '123')).toBe(false);
    expect(sameRecoveryPhone('', '')).toBe(false);
  });

  it('accepts only canonical UUIDs', () => {
    expect(RECOVERY_UUID.test('0d6b7c1e-7a8b-4c2d-9e0f-1a2b3c4d5e6f')).toBe(
      true,
    );
    expect(RECOVERY_UUID.test('0d6b7c1e7a8b4c2d9e0f1a2b3c4d5e6f')).toBe(false);
    expect(RECOVERY_UUID.test('zzzzzzzz-7a8b-4c2d-9e0f-1a2b3c4d5e6f')).toBe(
      false,
    );
  });
});

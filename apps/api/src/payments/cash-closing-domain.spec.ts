import {
  closingAmounts,
  decimalAmount,
  minorUnits,
} from './cash-closing-domain';

describe('cash closing money domain', () => {
  describe('minorUnits', () => {
    it.each([
      ['0', 0n],
      ['7', 700n],
      ['7.5', 750n],
      ['7.05', 705n],
      ['1234567890.99', 123456789099n],
    ])('parses %s exactly as %s cents', (input, expected) => {
      expect(minorUnits(input)).toBe(expected);
    });

    it.each([
      ['number instead of string', 7],
      ['three decimals', '1.005'],
      ['leading zero', '07'],
      ['negative', '-1'],
      ['exponent', '1e3'],
      ['empty', ''],
      ['spaces', ' 1'],
      ['too many digits', '12345678901'],
      ['null', null],
    ])('rejects %s', (_label, input) => {
      expect(() => minorUnits(input)).toThrow('MONEY_INVALID');
    });

    it('never loses precision like binary floats do', () => {
      expect(minorUnits('0.1') + minorUnits('0.2')).toBe(minorUnits('0.3'));
    });
  });

  describe('decimalAmount', () => {
    it.each([
      [0n, '0.00'],
      [5n, '0.05'],
      [750n, '7.50'],
      [-5n, '-0.05'],
      [-12345n, '-123.45'],
    ])('formats %s cents as %s', (input, expected) => {
      expect(decimalAmount(input)).toBe(expected);
    });

    it('round-trips with minorUnits', () => {
      for (const value of ['0.00', '1.01', '99.99', '157.40']) {
        expect(decimalAmount(minorUnits(value))).toBe(value);
      }
    });
  });

  describe('closingAmounts', () => {
    it('accepts an exact count without a reason', () => {
      expect(closingAmounts('157.40', '157.4', '')).toEqual({
        expected: '157.40',
        counted: '157.40',
        difference: '0.00',
        note: '',
      });
    });

    it('computes a signed difference and requires a reason for it', () => {
      expect(() => closingAmounts('100', '95', '')).toThrow(
        'DIFFERENCE_REASON_REQUIRED',
      );
      expect(() => closingAmounts('100', '95', ' faal ')).toThrow(
        'DIFFERENCE_REASON_REQUIRED',
      );
      expect(closingAmounts('100', '95', '  Faltante de cambio  ')).toEqual({
        expected: '100.00',
        counted: '95.00',
        difference: '-5.00',
        note: 'Faltante de cambio',
      });
      expect(
        closingAmounts('100', '100.5', 'Sobrante propina').difference,
      ).toBe('0.50');
    });

    it.each([
      ['non-string note', 12345],
      ['note over 500 chars', 'x'.repeat(501)],
      ['control characters', 'motivo\u0000oculto'],
      ['DEL character', 'motivo\u007f'],
    ])('rejects %s', (_label, note) => {
      expect(() => closingAmounts('1', '2', note)).toThrow('NOTE_INVALID');
    });

    it('rejects invalid money before looking at the note', () => {
      expect(() => closingAmounts('1.001', '1', 'motivo valido')).toThrow(
        'MONEY_INVALID',
      );
    });
  });
});

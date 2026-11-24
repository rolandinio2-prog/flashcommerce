import {
  getCurrentTableContextDate,
  getTableContextExpiration,
  issueTableContext,
  verifyTableContextToken,
} from './table-context-token';

describe('table QR context tokens', () => {
  const table = {
    tenant: 'POLLO001',
    branch: 'SUC001',
    tableId: 'table-1',
    tableCode: 'M01',
  };
  // 2026-11-21 15:00 La Paz (UTC-4) = 19:00 UTC
  const afternoon = new Date('2026-11-21T19:00:00Z');

  beforeAll(() => {
    process.env.FLASH_TABLE_CONTEXT_SECRET = 'unit-test-table-secret';
  });

  it('uses the La Paz calendar day', () => {
    expect(getCurrentTableContextDate(afternoon)).toBe('2026-11-21');
    // 23:30 La Paz is already the next day in UTC.
    expect(getCurrentTableContextDate(new Date('2026-11-22T03:30:00Z'))).toBe(
      '2026-11-21',
    );
    expect(getCurrentTableContextDate(new Date('2026-11-22T04:00:00Z'))).toBe(
      '2026-11-22',
    );
  });

  it('expires at the next local midnight (04:00 UTC)', () => {
    expect(getTableContextExpiration('2026-11-21')).toBe(
      '2026-11-22T04:00:00.000Z',
    );
    expect(getTableContextExpiration('2026-12-31')).toBe(
      '2027-01-01T04:00:00.000Z',
    );
    expect(() => getTableContextExpiration('21/11/2026')).toThrow();
  });

  it('round-trips a token issued today', () => {
    const issued = issueTableContext(table, afternoon);
    expect(issued.validOn).toBe('2026-11-21');
    expect(verifyTableContextToken(issued.token, afternoon)).toMatchObject({
      ...table,
      version: 1,
      validOn: '2026-11-21',
    });
  });

  it("rejects yesterday's token", () => {
    const issued = issueTableContext(table, afternoon);
    expect(
      verifyTableContextToken(issued.token, new Date('2026-11-22T13:00:00Z')),
    ).toBeNull();
  });

  it('rejects a tampered payload or signature', () => {
    const { token } = issueTableContext(table, afternoon);
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        tableCode: 'M99',
      }),
    ).toString('base64url');
    expect(
      verifyTableContextToken(`${forged}.${signature}`, afternoon),
    ).toBeNull();
    expect(
      verifyTableContextToken(
        `${payload}.${signature.slice(0, -2)}xx`,
        afternoon,
      ),
    ).toBeNull();
  });

  it.each(['', 'abc', 'a.b.c', '.', 'onlypayload.'])(
    'rejects malformed token %j',
    (token) => {
      expect(verifyTableContextToken(token, afternoon)).toBeNull();
    },
  );

  it('rejects a token signed with another secret', () => {
    const { token } = issueTableContext(table, afternoon);
    process.env.FLASH_TABLE_CONTEXT_SECRET = 'another-secret';
    expect(verifyTableContextToken(token, afternoon)).toBeNull();
    process.env.FLASH_TABLE_CONTEXT_SECRET = 'unit-test-table-secret';
  });
});

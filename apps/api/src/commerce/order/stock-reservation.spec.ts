import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { reserveOrderStock, stockHoldMinutes } from './stock-reservation';

function client(outcomes: Record<string, string>) {
  const query = jest.fn((_sql: string, params: unknown[]) =>
    Promise.resolve({ rows: [{ outcome: outcomes[params[3] as string] }] }),
  );
  return { client: { query } as unknown as PoolClient, query };
}
const base = { tenantId: 't', branchId: 'b', orderId: 'o' };

describe('stock reservation', () => {
  it('reads the hold from STOCK_HOLD_MINUTES within safe bounds', () => {
    expect(stockHoldMinutes('15')).toBe(15);
    expect(stockHoldMinutes(undefined)).toBe(30);
    expect(stockHoldMinutes('2')).toBe(30);
    expect(stockHoldMinutes('abc')).toBe(30);
    expect(stockHoldMinutes('9999')).toBe(30);
  });

  it('reserves every product in a stable order with its total quantity', async () => {
    const { client: c, query } = client({ a: 'RESERVED', b: 'UNTRACKED' });
    await reserveOrderStock(
      c,
      {
        ...base,
        quantities: new Map([
          ['b', 1],
          ['a', 3],
        ]),
        names: new Map(),
      },
      20,
    );
    const params = (query.mock.calls as unknown[][]).map((call) => call[1]);
    expect(params).toEqual([
      ['t', 'b', 'o', 'a', 3, 20],
      ['t', 'b', 'o', 'b', 1, 20],
    ]);
  });

  it('rejects the checkout when another order took the last units', async () => {
    const { client: c } = client({ a: 'INSUFFICIENT' });
    await expect(
      reserveOrderStock(c, {
        ...base,
        quantities: new Map([['a', 2]]),
        names: new Map([['a', 'Coca-Cola · Personal']]),
      }),
    ).rejects.toThrow(
      new ConflictException(
        'Coca-Cola · Personal: ya no hay unidades suficientes. Revisa tu pedido.',
      ),
    );
  });

  it('skips non-positive quantities and fails on unknown outcomes', async () => {
    const skip = client({});
    await reserveOrderStock(skip.client, {
      ...base,
      quantities: new Map([['a', 0]]),
      names: new Map(),
    });
    expect(skip.query).not.toHaveBeenCalled();
    const bad = client({ a: 'WHAT' });
    await expect(
      reserveOrderStock(bad.client, {
        ...base,
        quantities: new Map([['a', 1]]),
        names: new Map(),
      }),
    ).rejects.toThrow('Unexpected stock reservation outcome');
  });
});

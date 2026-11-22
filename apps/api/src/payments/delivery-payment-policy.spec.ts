import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

import {
  assertDeliveryQrPaid,
  deliveryQrProvider,
} from './delivery-payment-policy';

const scope = { tenant_id: 't', branch_id: 'b', order_id: 'o' };

function client(order: Record<string, string> | null, eligible: boolean) {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: order ? [order] : [] })
    .mockResolvedValueOnce({ rows: [{ eligible }] });
  return { client: { query } as unknown as PoolClient, query };
}
const paidDelivery = {
  payment_status: 'PAID',
  order_type: 'DELIVERY',
  total: '73.00',
  currency: 'BOB',
};

describe('delivery QR payment policy', () => {
  const original = process.env.PAYMENT_PROVIDER;
  afterEach(() => {
    if (original === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = original;
  });

  it('uses the environment provider (production BCP_QR, lab/staging MOCK)', () => {
    expect(deliveryQrProvider('BCP_QR')).toBe('BCP_QR');
    expect(deliveryQrProvider(' mock ')).toBe('MOCK');
    expect(deliveryQrProvider(undefined)).toBe('BCP_QR');
    expect(deliveryQrProvider('anything-else')).toBe('BCP_QR');
  });

  it.each([
    ['BCP_QR', 'BCP_QR'],
    ['MOCK', 'MOCK'],
  ])(
    'with PAYMENT_PROVIDER=%s only accepts confirmed %s payments for the full amount',
    async (env, provider) => {
      process.env.PAYMENT_PROVIDER = env;
      const { client: c, query } = client(paidDelivery, true);
      await expect(assertDeliveryQrPaid(c, scope)).resolves.toBeUndefined();
      expect((query.mock.calls as unknown[][][])[1][1]).toEqual([
        't',
        'b',
        'o',
        '73.00',
        'BOB',
        provider,
      ]);
    },
  );

  it('rejects when no eligible confirmed QR payment exists', async () => {
    const { client: c } = client(paidDelivery, false);
    await expect(assertDeliveryQrPaid(c, scope)).rejects.toThrow(
      'No existe un pago QR confirmado por el importe completo del pedido.',
    );
  });

  it.each([
    [
      'unpaid order',
      { ...paidDelivery, payment_status: 'AWAITING_CONFIRMATION' },
    ],
    ['non-delivery order', { ...paidDelivery, order_type: 'TAKEAWAY' }],
    ['missing order', null],
  ])('rejects a %s before checking payments', async (_label, order) => {
    const { client: c, query } = client(order, true);
    await expect(assertDeliveryQrPaid(c, scope)).rejects.toThrow(
      ConflictException,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});

import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

/** Minutes an unpaid PENDING order keeps its units before they return to stock. */
export function stockHoldMinutes(
  configured: string | undefined = process.env.STOCK_HOLD_MINUTES,
): number {
  const value = Number(configured);
  return Number.isInteger(value) && value >= 5 && value <= 1440 ? value : 30;
}

export interface ReserveOrderStockInput {
  tenantId: string;
  branchId: string;
  orderId: string;
  quantities: ReadonlyMap<string, number>;
  names: ReadonlyMap<string, string>;
}

/**
 * Reserves units for every product with tracked inventory, inside the checkout
 * transaction. Products are processed in a stable order so concurrent checkouts
 * lock branch_products rows in the same sequence (no deadlocks).
 */
export async function reserveOrderStock(
  client: PoolClient,
  input: ReserveOrderStockInput,
  holdMinutes: number = stockHoldMinutes(),
): Promise<void> {
  const productIds = [...input.quantities.keys()].sort();
  for (const productId of productIds) {
    const quantity = input.quantities.get(productId) ?? 0;
    if (quantity <= 0) continue;
    const result = await client.query<{ outcome: string }>(
      'select public.stock_reserve_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::integer,make_interval(mins => $6::integer)) as outcome',
      [
        input.tenantId,
        input.branchId,
        input.orderId,
        productId,
        quantity,
        holdMinutes,
      ],
    );
    const outcome = result.rows[0]?.outcome;
    if (outcome === 'INSUFFICIENT') {
      const name = input.names.get(productId) ?? 'Producto';
      throw new ConflictException(
        `${name}: ya no hay unidades suficientes. Revisa tu pedido.`,
      );
    }
    if (outcome !== 'RESERVED' && outcome !== 'UNTRACKED') {
      throw new Error(`Unexpected stock reservation outcome: ${outcome}`);
    }
  }
}

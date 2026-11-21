import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface PosCheckoutInput {
  cartToken?: string;
  orderType?: string;
  customerName?: string;
  customerPhone?: string;
  customerNotes?: string;
  expectedTotal?: number;
  expectedRevision?: string;
}
export function normalizePosCheckout(input: PosCheckoutInput) {
  if (
    !input ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.cartToken ?? '',
    )
  )
    throw new BadRequestException('Carrito inválido.');
  if (input.orderType !== 'DINE_IN' && input.orderType !== 'TAKEAWAY')
    throw new BadRequestException(
      'Caja admite consumo en local o para llevar.',
    );
  if (
    typeof input.expectedTotal !== 'number' ||
    !Number.isFinite(input.expectedTotal) ||
    input.expectedTotal <= 0 ||
    Math.abs(
      input.expectedTotal * 100 - Math.round(input.expectedTotal * 100),
    ) > 0.00001
  )
    throw new BadRequestException('Total inválido.');
  if (
    typeof input.expectedRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.expectedRevision)
  )
    throw new BadRequestException('Revisa el carrito actualizado.');
  const text = (value: unknown, max: number) => {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > max)
      throw new BadRequestException('Datos inválidos.');
    return value.trim();
  };
  const customerName = text(input.customerName, 120),
    customerPhone = text(input.customerPhone, 25),
    customerNotes = text(input.customerNotes, 500);
  if (
    customerPhone &&
    (!/^\+?[0-9 ()-]{7,25}$/.test(customerPhone) ||
      !/^[0-9]{7,15}$/.test(customerPhone.replace(/\D/g, '')))
  )
    throw new BadRequestException('Teléfono inválido.');
  const normalized = {
    cartToken: input.cartToken!.toLowerCase(),
    orderType: input.orderType,
    customerName,
    customerPhone,
    customerNotes,
    expectedTotal: input.expectedTotal,
    expectedRevision: input.expectedRevision,
  };
  return {
    ...normalized,
    intentHash: createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex'),
  };
}

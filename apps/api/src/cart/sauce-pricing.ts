import { BadRequestException, ConflictException } from '@nestjs/common';

// This menu promotion belongs only to the configured restaurant/branch.
const SAUCE_SKUS = new Set(['SALSA-APIO', 'SALSA-AJO', 'SALSA-PICANTE', 'SALSA-MOSTAZA-DULCE', 'SALSA-MARACUYA', 'SALSA-BARBACOA']);
// Recognize the server-generated Admin SKU while retaining the branch promotion scope.
// An arbitrary SALSA prefix is not sufficient.
const isPromotionSauceSku = (sku: string | null) => SAUCE_SKUS.has(sku ?? '') || /^SALSA-[0-9A-F]{32}$/.test(sku ?? '');
export interface SaucePricingItem {
  sauce_included_quantity?: number | null;
  sku: string | null; quantity: number; requires_rice: boolean;
  price: string | number | null; currency: string | null;
}

export function saucePricing(tenant: string, branch: string, items: SaucePricingItem[], validateSelection = false) {
  const active = tenant === 'POLLO001' && branch === 'SUC001';
  const sauces = active ? items.filter(item => isPromotionSauceSku(item.sku)) : [];
  for (const item of sauces) {
    if (item.currency !== 'BOB' || Number(item.price) !== 7 || !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new ConflictException('El precio o disponibilidad de las salsas cambió. Actualiza el menú.');
    }
  }
  const includedLimit = active ? 2 : 0;
  const selected = sauces.reduce((total, item) => total + item.quantity, 0);
  const included = Math.min(selected, includedLimit);
  const extra = selected - included;
  // Allowance starts with the first sauce; only chicken orders require both portions.
  const missing = active && items.some(item => item.requires_rice) ? Math.max(0, includedLimit - selected) : 0;
  if (validateSelection && missing > 0) throw new BadRequestException('Elige tus dos salsas incluidas antes de confirmar el pedido.');
  return { selected, includedLimit, included, extra, extraTotal: extra * 7, missing, discountTotal: 0 };
}

export function priceSauceLines<T extends SaucePricingItem>(tenant: string, branch: string, items: T[], validateSelection = false) {
  const summary = saucePricing(tenant, branch, items, validateSelection);
  const eligible = (item: T) => tenant === 'POLLO001' && branch === 'SUC001' && isPromotionSauceSku(item.sku);
  let remaining = summary.included;
  // Preserve each flavor's saved allowance before allocating any unclaimed portions.
  // NULL is a legacy cart or a newly inserted line, initialized on its next mutation.
  const included = items.map(item => {
    if (!eligible(item)) return 0;
    const saved = item.sauce_included_quantity ?? 0;
    if (!Number.isSafeInteger(saved) || saved < 0 || saved > 2) throw new ConflictException('Actualiza el carrito para verificar tus salsas incluidas.');
    const count = Math.min(saved, item.quantity, remaining);
    remaining -= count;
    return count;
  });
  return items.map((item, index) => {
    const available = eligible(item) ? Math.min(remaining, item.quantity - included[index]) : 0;
    remaining -= available;
    const includedQuantity = included[index] + available;
    return { ...item, includedQuantity, lineTotal: (item.quantity - includedQuantity) * Number(item.price) };
  });
}

// Keep all portions for kitchen/history, with exact zero/paid unit prices.
export function sauceOrderItems<T extends SaucePricingItem & { name: string }>(tenant: string, branch: string, items: T[]) {
  return priceSauceLines(tenant, branch, items, true).flatMap(item => {
    const parts: T[] = [];
    if (item.includedQuantity > 0) parts.push({ ...item, quantity: item.includedQuantity, price: '0', name: `${item.name} · Incluida` });
    const paid = item.quantity - item.includedQuantity;
    if (paid > 0) parts.push({ ...item, quantity: paid });
    return parts;
  });
}

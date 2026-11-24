import { BadRequestException, ConflictException } from '@nestjs/common';

import {
  priceSauceLines,
  sauceOrderItems,
  saucePricing,
  type SaucePricingItem,
} from './sauce-pricing';

const sauce = (
  sku: string,
  quantity: number,
  extra: Partial<SaucePricingItem> = {},
): SaucePricingItem & { name: string } => ({
  sku,
  quantity,
  requires_rice: false,
  price: '7.00',
  currency: 'BOB',
  name: sku,
  ...extra,
});
const chicken = (quantity = 1): SaucePricingItem & { name: string } => ({
  sku: 'POL-BROASTER',
  quantity,
  requires_rice: true,
  price: '60.00',
  currency: 'BOB',
  name: 'Pollo Broaster',
});

describe('sauce promotion pricing (POLLO001/SUC001)', () => {
  it('includes the first two sauces and charges 7 BOB for each extra one', () => {
    const summary = saucePricing('POLLO001', 'SUC001', [
      chicken(),
      sauce('SALSA-AJO', 2),
      sauce('SALSA-APIO', 1),
    ]);
    expect(summary).toMatchObject({
      selected: 3,
      included: 2,
      extra: 1,
      extraTotal: 7,
      missing: 0,
    });
  });

  it('reports missing included sauces only for chicken orders', () => {
    expect(
      saucePricing('POLLO001', 'SUC001', [chicken(), sauce('SALSA-AJO', 1)])
        .missing,
    ).toBe(1);
    expect(
      saucePricing('POLLO001', 'SUC001', [sauce('SALSA-AJO', 1)]).missing,
    ).toBe(0);
  });

  it('blocks checkout when a chicken order lacks its two sauces', () => {
    expect(() => saucePricing('POLLO001', 'SUC001', [chicken()], true)).toThrow(
      BadRequestException,
    );
  });

  it('applies no promotion outside the configured tenant/branch', () => {
    const summary = saucePricing('OTHER001', 'SUC001', [
      chicken(),
      sauce('SALSA-AJO', 3),
    ]);
    expect(summary).toMatchObject({ selected: 0, included: 0, missing: 0 });
  });

  it('accepts server-generated admin sauce SKUs but not arbitrary SALSA- prefixes', () => {
    const generated = `SALSA-${'A1'.repeat(16)}`;
    expect(
      saucePricing('POLLO001', 'SUC001', [sauce(generated, 1)]).selected,
    ).toBe(1);
    expect(
      saucePricing('POLLO001', 'SUC001', [sauce('SALSA-GRATIS', 5)]).selected,
    ).toBe(0);
  });

  it.each([
    ['price changed', { price: '6.00' }],
    ['other currency', { currency: 'USD' }],
  ])('rejects a promotion sauce when %s', (_label, change) => {
    expect(() =>
      saucePricing('POLLO001', 'SUC001', [sauce('SALSA-AJO', 1, change)]),
    ).toThrow(ConflictException);
  });

  it('rejects non-integer or non-positive quantities', () => {
    for (const quantity of [0, -1, 1.5]) {
      expect(() =>
        saucePricing('POLLO001', 'SUC001', [sauce('SALSA-AJO', quantity)]),
      ).toThrow(ConflictException);
    }
  });

  describe('priceSauceLines', () => {
    it('allocates the two free portions across lines and prices the rest', () => {
      const lines = priceSauceLines('POLLO001', 'SUC001', [
        chicken(),
        sauce('SALSA-AJO', 1),
        sauce('SALSA-APIO', 3),
      ]);
      expect(
        lines.map((l) => [l.sku, l.includedQuantity, l.lineTotal]),
      ).toEqual([
        ['POL-BROASTER', 0, 60],
        ['SALSA-AJO', 1, 0],
        ['SALSA-APIO', 1, 14],
      ]);
    });

    it('keeps the allowance already saved on a line before allocating new ones', () => {
      const lines = priceSauceLines('POLLO001', 'SUC001', [
        sauce('SALSA-AJO', 2),
        sauce('SALSA-APIO', 2, { sauce_included_quantity: 2 }),
      ]);
      expect(lines.map((l) => l.includedQuantity)).toEqual([0, 2]);
    });

    it('rejects a tampered saved allowance', () => {
      expect(() =>
        priceSauceLines('POLLO001', 'SUC001', [
          sauce('SALSA-AJO', 3, { sauce_included_quantity: 3 }),
        ]),
      ).toThrow(ConflictException);
    });
  });

  describe('sauceOrderItems', () => {
    it('splits included and paid portions with exact unit prices for the kitchen', () => {
      const items = sauceOrderItems('POLLO001', 'SUC001', [
        chicken(),
        sauce('SALSA-AJO', 3),
      ]);
      expect(items.map((i) => [i.name, i.quantity, i.price])).toEqual([
        ['Pollo Broaster', 1, '60.00'],
        ['SALSA-AJO · Incluida', 2, '0'],
        ['SALSA-AJO', 1, '7.00'],
      ]);
    });
  });
});

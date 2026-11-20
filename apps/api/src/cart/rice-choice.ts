import { BadRequestException } from '@nestjs/common';
export type RiceChoice = '' | 'WHITE' | 'CHAUFA';
export function riceChoice(value: unknown): RiceChoice {
  if (value === undefined || value === '') return '';
  if (value === 'WHITE' || value === 'CHAUFA') return value;
  throw new BadRequestException('Elige arroz blanco o arroz chaufa.');
}
export function validateRice(required: boolean, choice: RiceChoice) {
  if (required && !choice) throw new BadRequestException('Elige el arroz del pollo. Si estaba guardado antes, elimínalo del carrito y vuelve a agregarlo con arroz blanco o chaufa.');
  if (!required && choice) throw new BadRequestException('Este producto no permite elegir arroz incluido.');
}
export function riceName(name: string, choice: RiceChoice) {
  return name + (choice === 'WHITE' ? ' · Arroz blanco' : choice === 'CHAUFA' ? ' · Arroz chaufa' : '');
}

export function prepareRiceItems<T extends {product_id:string;rice_choice:string;requires_rice:boolean;name:string;quantity:number}>(items:T[]) {
  const quantitiesByProduct = new Map<string,number>();
  for (const item of items) {
    const choice = riceChoice(item.rice_choice);
    validateRice(item.requires_rice,choice);
    item.name = riceName(item.name,choice);
    quantitiesByProduct.set(item.product_id,(quantitiesByProduct.get(item.product_id) ?? 0) + item.quantity);
  }
  return quantitiesByProduct;
}

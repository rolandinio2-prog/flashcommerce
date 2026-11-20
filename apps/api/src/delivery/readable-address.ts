type AddressComponent = { longText: string; types: string[] };

/** Use typed components, never strip arbitrary numbers from a street or house. */
export function readableAddress(input: unknown): { text: string; hasDetail: boolean } {
  const components: AddressComponent[] = Array.isArray(input) ? input.flatMap(value => {
    if (!value || typeof value !== 'object' || typeof value.longText !== 'string' || !Array.isArray(value.types)) return [];
    const text = value.longText.trim().replace(/\s+/g, ' ');
    return text ? [{ longText: text, types: value.types.filter((type: unknown): type is string => typeof type === 'string') }] : [];
  }) : [];
  const part = (type: string) => components.find(component => component.types.includes(type))?.longText;
  const street = part('route');
  const number = part('street_number');
  const premise = part('premise');
  const city = part('locality') ?? part('postal_town') ?? part('administrative_area_level_2');
  const detail = street ? [street, number].filter(Boolean).join(' ') : premise;
  const unique = (values: (string | undefined)[]) => values.filter((value, index, list) =>
    value && list.findIndex(other => other?.toLocaleLowerCase() === value.toLocaleLowerCase()) === index).join(', ');
  if (detail) return { text: unique([detail, city]), hasDetail: true };
  return { text: city ? `Ubicación aproximada en ${city}` : 'Ubicación sin dirección detallada', hasDetail: false };
}

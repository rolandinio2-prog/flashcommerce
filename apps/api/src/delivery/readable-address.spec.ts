import { readableAddress } from './readable-address';

const c = (longText: unknown, ...types: unknown[]) => ({ longText, types });

describe('readableAddress (Google Places components)', () => {
  it('builds "street number, city" from typed components', () => {
    expect(
      readableAddress([
        c('Avenida  Cristo   Redentor', 'route'),
        c('1234', 'street_number'),
        c('Santa Cruz de la Sierra', 'locality'),
      ]),
    ).toEqual({
      text: 'Avenida Cristo Redentor 1234, Santa Cruz de la Sierra',
      hasDetail: true,
    });
  });

  it('falls back to the premise when there is no street', () => {
    expect(
      readableAddress([
        c('Condominio Las Palmas', 'premise'),
        c('Santa Cruz', 'locality'),
      ]),
    ).toEqual({ text: 'Condominio Las Palmas, Santa Cruz', hasDetail: true });
  });

  it('does not repeat the city when it equals the detail', () => {
    expect(
      readableAddress([c('Warnes', 'premise'), c('warnes', 'locality')]).text,
    ).toBe('Warnes');
  });

  it('reports an approximate location when only the city is known', () => {
    expect(
      readableAddress([c('Cotoca', 'administrative_area_level_2')]),
    ).toEqual({
      text: 'Ubicación aproximada en Cotoca',
      hasDetail: false,
    });
  });

  it('ignores malformed components and non-string types', () => {
    expect(
      readableAddress([
        null,
        'texto',
        { longText: 5, types: ['route'] },
        { longText: 'Calle Sin Tipos' },
        c('Calle Real', 'route', 42),
        c('   ', 'locality'),
      ]),
    ).toEqual({ text: 'Calle Real', hasDetail: true });
  });

  it('handles non-array input', () => {
    expect(readableAddress(undefined)).toEqual({
      text: 'Ubicación sin dirección detallada',
      hasDetail: false,
    });
  });
});

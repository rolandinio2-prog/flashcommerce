import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

export const TABLE_CONTEXT_TIME_ZONE =
  'America/La_Paz';

const LOCAL_DEVELOPMENT_SECRET =
  'flashcommerce-local-table-context-v1';

export interface TableContextPayload {
  version: 1;
  tenant: string;
  branch: string;
  tableId: string;
  tableCode: string;
  tableSessionId?: string;
  validOn: string;
}

export interface IssuedTableContext {
  token: string;
  validOn: string;
  expiresAt: string;
}

function getSigningSecret() {
  const configuredSecret =
    process.env.FLASH_TABLE_CONTEXT_SECRET?.trim();

  if (configuredSecret) {
    return configuredSecret;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'FLASH_TABLE_CONTEXT_SECRET is required in production',
    );
  }

  return LOCAL_DEVELOPMENT_SECRET;
}

function getLaPazDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat(
    'en-US',
    {
      timeZone: TABLE_CONTEXT_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    },
  ).formatToParts(date);

  const values = Object.fromEntries(
    parts.map((part) => [
      part.type,
      part.value,
    ]),
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

export function getCurrentTableContextDate(
  now = new Date(),
) {
  const { year, month, day } =
    getLaPazDateParts(now);

  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

export function getTableContextExpiration(
  validOn: string,
) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(
      validOn,
    );

  if (!match) {
    throw new Error(
      'Invalid table context date',
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // America/La_Paz permanece en UTC-04:00 durante todo el año.
  // La siguiente medianoche local corresponde a las 04:00 UTC.
  return new Date(
    Date.UTC(
      year,
      month - 1,
      day + 1,
      4,
      0,
      0,
      0,
    ),
  ).toISOString();
}

function sign(encodedPayload: string) {
  return createHmac(
    'sha256',
    getSigningSecret(),
  )
    .update(encodedPayload)
    .digest('base64url');
}

export function issueTableContext(
  input: Omit<
    TableContextPayload,
    'version' | 'validOn'
  >,
  now = new Date(),
): IssuedTableContext {
  const validOn =
    getCurrentTableContextDate(now);

  const payload: TableContextPayload = {
    version: 1,
    tenant: input.tenant,
    branch: input.branch,
    tableId: input.tableId,
    tableCode: input.tableCode,
    tableSessionId: input.tableSessionId,
    validOn,
  };

  const encodedPayload = Buffer.from(
    JSON.stringify(payload),
    'utf8',
  ).toString('base64url');

  return {
    token: `${encodedPayload}.${sign(encodedPayload)}`,
    validOn,
    expiresAt:
      getTableContextExpiration(validOn),
  };
}

export function verifyTableContextToken(
  token: string,
  now = new Date(),
): TableContextPayload | null {
  const [encodedPayload, signature, extra] =
    token.split('.');

  if (
    !encodedPayload ||
    !signature ||
    extra !== undefined
  ) {
    return null;
  }

  const expectedSignature =
    sign(encodedPayload);

  const actualBuffer = Buffer.from(
    signature,
    'utf8',
  );

  const expectedBuffer = Buffer.from(
    expectedSignature,
    'utf8',
  );

  if (
    actualBuffer.length !==
      expectedBuffer.length ||
    !timingSafeEqual(
      actualBuffer,
      expectedBuffer,
    )
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(
        encodedPayload,
        'base64url',
      ).toString('utf8'),
    ) as Partial<TableContextPayload>;

    if (
      payload.version !== 1 ||
      typeof payload.tenant !== 'string' ||
      typeof payload.branch !== 'string' ||
      typeof payload.tableId !== 'string' ||
      typeof payload.tableCode !== 'string' ||
      (
        payload.tableSessionId !== undefined &&
        typeof payload.tableSessionId !== 'string'
      ) ||
      typeof payload.validOn !== 'string' ||
      payload.validOn !==
        getCurrentTableContextDate(now)
    ) {
      return null;
    }

    return payload as TableContextPayload;
  } catch {
    return null;
  }
}

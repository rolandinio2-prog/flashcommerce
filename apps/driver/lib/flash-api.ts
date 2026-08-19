const configuredApiBase =
  process.env.NEXT_PUBLIC_FLASH_API_URL?.trim();

export const flashApiBase = (
  configuredApiBase || "http://localhost:3001"
).replace(/\/+$/, "");

export type DriverSession = Record<string, unknown>;

export class FlashApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FlashApiError";
  }
}

export async function getDriverMe(
  accessToken: string,
): Promise<DriverSession> {
  const token = accessToken.trim();

  if (!token) {
    throw new FlashApiError(
      401,
      "Falta el token de acceso del repartidor.",
    );
  }

  const response = await fetch(
    `${flashApiBase}/api/v1/driver/me`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    if (response.status === 401) {
      throw new FlashApiError(
        401,
        "El token del repartidor no es valido o ya no esta habilitado.",
      );
    }

    throw new FlashApiError(
      response.status,
      `No se pudo validar la sesion del repartidor. HTTP ${response.status}.`,
    );
  }

  return (await response.json()) as DriverSession;
}
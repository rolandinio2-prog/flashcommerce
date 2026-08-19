export const flashApiBase = "/api/v1";

export type DriverSession = Record<string, unknown>;
export type DriverActiveDelivery = {
  delivery: {
    id: string;
    status: string;
  };
  order: {
    number: string;
    status: string;
  };
  assignment: {
    id: string;
    number: number;
    status: string;
  };
  recipient: {
    name: string;
    phone: string;
  };
  destination: {
    address: string;
    reference: string | null;
  };
  eta: {
    minMinutes: number | null;
    maxMinutes: number | null;
  };
};

export type DriverActiveDeliveries = {
  total: number;
  deliveries: DriverActiveDelivery[];
};

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
    `${flashApiBase}/driver/me`,
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

export async function getDriverActiveDeliveries(
  accessToken: string,
): Promise<DriverActiveDeliveries> {
  const token = accessToken.trim();

  if (!token) {
    throw new FlashApiError(
      401,
      "Falta el token de acceso del repartidor.",
    );
  }

  const response = await fetch(
    `${flashApiBase}/driver/deliveries/active`,
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

    if (response.status === 409) {
      throw new FlashApiError(
        409,
        "Las entregas activas tienen un estado inconsistente.",
      );
    }

    throw new FlashApiError(
      response.status,
      `No se pudieron cargar las entregas activas. HTTP ${response.status}.`,
    );
  }

  return (await response.json()) as DriverActiveDeliveries;
}

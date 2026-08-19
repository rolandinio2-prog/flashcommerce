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

export type DriverLocationSample = {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  headingDegrees?: number | null;
  speedMps?: number | null;
  capturedAt?: string | null;
};

export type DriverLocationResult = {
  recorded: true;
  delivery: {
    id: string;
    status: string;
  };
  assignment: {
    id: string;
    number: number;
    status: string;
    driver: {
      id: string;
    };
  };
  location: {
    id: string;
    latitude: number;
    longitude: number;
    accuracyMeters: number | null;
    headingDegrees: number | null;
    speedMps: number | null;
    capturedAt: string;
    receivedAt: string;
  };
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

export async function postDriverLocation(
  accessToken: string,
  deliveryId: string,
  sample: DriverLocationSample,
): Promise<DriverLocationResult> {
  const token = accessToken.trim();
  const normalizedDeliveryId =
    deliveryId.trim();

  if (!token) {
    throw new FlashApiError(
      401,
      "Falta el token de acceso del repartidor.",
    );
  }

  if (!normalizedDeliveryId) {
    throw new FlashApiError(
      400,
      "Falta la entrega seleccionada para registrar la ubicacion.",
    );
  }

  const response = await fetch(
    `${flashApiBase}/driver/deliveries/${encodeURIComponent(
      normalizedDeliveryId,
    )}/location`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      body: JSON.stringify(sample),
    },
  );

  if (!response.ok) {
    if (response.status === 400) {
      throw new FlashApiError(
        400,
        "La muestra de ubicacion no es valida.",
      );
    }

    if (response.status === 401) {
      throw new FlashApiError(
        401,
        "El token del repartidor no es valido o ya no esta habilitado.",
      );
    }

    if (response.status === 403) {
      throw new FlashApiError(
        403,
        "El repartidor no esta autorizado para registrar esta ubicacion.",
      );
    }

    if (response.status === 404) {
      throw new FlashApiError(
        404,
        "La entrega no esta disponible para registrar ubicacion.",
      );
    }

    if (response.status === 409) {
      throw new FlashApiError(
        409,
        "La entrega ya no esta en un estado valido para registrar ubicacion.",
      );
    }

    if (response.status === 429) {
      throw new FlashApiError(
        429,
        "Se alcanzo temporalmente el limite de muestras de ubicacion.",
      );
    }

    throw new FlashApiError(
      response.status,
      `No se pudo registrar la ubicacion. HTTP ${response.status}.`,
    );
  }

  return (await response.json()) as DriverLocationResult;
}

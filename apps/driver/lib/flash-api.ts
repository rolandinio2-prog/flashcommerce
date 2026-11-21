export const flashApiBase = "/api/v1";

export type DriverSession = {
  authenticated: true;
  tenant: {
    id: string;
    code: string;
  };
  driver: {
    id: string;
    code: string;
    displayName: string;
    phone: string;
    status: string;
    passwordChangeRequired: boolean;
  };
  credential: {
    expiresAt: string | null;
  };
};

export type DriverLoginResult = {
  authenticated: true;
  accessToken: string;
  expiresAt: string;
  passwordChangeRequired: boolean;
  tenant: {
    id: string;
    code: string;
  };
  driver: {
    id: string;
    code: string;
    displayName: string;
    phone: string;
  };
};
export type DriverActiveDelivery = {
  branchOrigin?: {name: string; latitude: number; longitude: number} | null;
  delivery: {
    id: string;
    status: string;

    relationshipRole:
      | "PRIMARY"
      | "ADDITIONAL";

    memberCount: number;
    isShared: boolean;

    memberOrders: Array<{
      number: string;
      status: string;
      paymentStatus: string;
      relationshipRole:
        | "PRIMARY"
        | "ADDITIONAL";
    }>;
  };

  order: {
    number: string;
    status: string;
    paymentStatus: string;
  };

  payment:
    | {
        method: "CASH";
        provider: "DRIVER_COD";
        status: string;
        amount: number;
        currency: string;
        cashOnDelivery: true;
        cashCollectionRequired: boolean;
      }
    | null;

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

    location: {
      latitude: number;
      longitude: number;
    };
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

export type JourneyPoint = { latitude: number; longitude: number };
export type DriverJourney = {
  segments: JourneyPoint[][];
  distanceMeters: number | null;
  complete: boolean;
  gaps: number;
  rejected: number;
};
export type DriverNavigation = {
  remainingPath: JourneyPoint[];
  revision: number;
  status: 'READY' | 'OFF_ROUTE' | 'STALE_ROUTE' | 'STALE_LOCATION' | 'UNAVAILABLE';
  distanceMeters: number | null;
  durationSeconds: number | null;
};

export type DriverMapRoute = {
  baseRoute?: {identity:string|null;status:'READY'|'UNAVAILABLE'|'MISSING_ORIGIN'|'HIDDEN';path:JourneyPoint[];route:{distanceMeters:number;durationSeconds:number;encodedPolyline:string}|null};
  delivery: {
    id: string;
    status: string;
  };

  location: {
    latitude: number;
    longitude: number;
    capturedAt: string;
  } | null;

  destination: {
    latitude: number;
    longitude: number;
  };

  journey: DriverJourney;
  navigation: DriverNavigation;
  route: {
    distanceMeters: number;
    durationSeconds: number;
    encodedPolyline: string;
  } | null;
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


export async function loginDriver(
  tenantCode: string,
  driverCode: string,
  password: string,
): Promise<DriverLoginResult> {
  const response = await fetch(`${flashApiBase}/driver/auth/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tenantCode: tenantCode.trim().toUpperCase(),
      driverCode: driverCode.trim().toUpperCase(),
      password,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new FlashApiError(
      response.status,
      response.status === 401
        ? "Código de repartidor o contraseña incorrectos."
        : `No se pudo iniciar sesión. HTTP ${response.status}.`,
    );
  }

  return (await response.json()) as DriverLoginResult;
}

export async function changeDriverPassword(
  accessToken: string,
  newPassword: string,
): Promise<{ changed: true; passwordChangeRequired: false }> {
  const token = accessToken.trim();

  if (!token) {
    throw new FlashApiError(401, "No hay una sesión válida del repartidor.");
  }

  const response = await fetch(`${flashApiBase}/driver/auth/change-password`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ newPassword }),
    cache: "no-store",
  });

  if (!response.ok) {
    let message = `No se pudo cambiar la contraseña. HTTP ${response.status}.`;

    try {
      const payload = (await response.json()) as { message?: unknown };
      if (typeof payload.message === "string" && payload.message.trim()) {
        message = payload.message.trim();
      }
    } catch {
      // Conservamos el mensaje seguro del cliente.
    }

    throw new FlashApiError(response.status, message);
  }

  return (await response.json()) as {
    changed: true;
    passwordChangeRequired: false;
  };
}

export async function logoutDriver(accessToken: string): Promise<void> {
  const token = accessToken.trim();

  if (!token) {
    return;
  }

  try {
    await fetch(`${flashApiBase}/driver/auth/logout`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });
  } catch {
    // El cierre local de sesión sigue siendo válido aunque falle la red.
  }
}

export async function getDriverMe(
  accessToken: string,
): Promise<DriverSession> {
  const token = accessToken.trim();

  if (!token) {
    throw new FlashApiError(
      401,
      "No hay una sesión válida del repartidor.",
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
        "La sesión del repartidor no es válida o ya no está habilitada.",
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
      "No hay una sesión válida del repartidor.",
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
        "La sesión del repartidor no es válida o ya no está habilitada.",
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
  options?: {
    signal?: AbortSignal;
  },
): Promise<DriverLocationResult> {
  const token = accessToken.trim();
  const normalizedDeliveryId =
    deliveryId.trim();

  if (!token) {
    throw new FlashApiError(
      401,
      "No hay una sesión válida del repartidor.",
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
      signal: options?.signal,
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
        "La sesión del repartidor no es válida o ya no está habilitada.",
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

export async function getDriverDeliveryMapRoute(
  accessToken: string,
  deliveryId: string,
): Promise<DriverMapRoute> {
  const context =
    requireDriverMutationContext(
      accessToken,
      deliveryId,
    );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const response =
    await fetch(
      `${flashApiBase}/driver/deliveries/${encodeURIComponent(
        context.deliveryId,
      )}/map-route`,
      {
        method: "GET",
        signal: controller.signal,

        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${context.token}`,
        },

        cache: "no-store",
      },
    ).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    if (response.status === 409) {
      throw new FlashApiError(
        409,
        "La ubicacion del repartidor aun no esta disponible.",
      );
    }

    throw new FlashApiError(
      response.status,
      `No se pudo calcular la ruta de entrega. HTTP ${response.status}.`,
    );
  }

  return (await response.json()) as DriverMapRoute;
}

type DriverMutationResult =
  Record<string, unknown>;

const DRIVER_IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireDriverMutationContext(
  accessToken: string,
  deliveryId: string,
) {
  const token =
    accessToken.trim();

  const normalizedDeliveryId =
    deliveryId.trim();

  if (!token) {
    throw new FlashApiError(
      401,
      "No hay una sesión válida del repartidor.",
    );
  }

  if (!normalizedDeliveryId) {
    throw new FlashApiError(
      400,
      "Falta la entrega seleccionada.",
    );
  }

  return {
    token,
    deliveryId:
      normalizedDeliveryId,
  };
}

async function readDriverMutationResponse(
  response: Response,
  fallbackMessage: string,
): Promise<DriverMutationResult> {
  if (!response.ok) {
    let message =
      fallbackMessage;

    try {
      const payload =
        (await response.json()) as {
          message?: unknown;
        };

      if (
        typeof payload.message === "string" &&
        payload.message.trim()
      ) {
        message =
          payload.message.trim();
      }
      else if (
        Array.isArray(
          payload.message,
        )
      ) {
        const messages =
          payload.message.filter(
            (value): value is string =>
              typeof value === "string",
          );

        if (messages.length > 0) {
          message =
            messages.join(" ");
        }
      }
    }
    catch {
      // Conservamos un mensaje seguro del cliente.
    }

    throw new FlashApiError(
      response.status,
      message,
    );
  }

  return (
    await response.json()
  ) as DriverMutationResult;
}

async function patchDriverDeliveryAction(
  accessToken: string,
  deliveryId: string,
  action:
    | "accept"
    | "pickup"
    | "en-route"
    | "arrive",
): Promise<DriverMutationResult> {
  const context =
    requireDriverMutationContext(
      accessToken,
      deliveryId,
    );

  const response =
    await fetch(
      `${flashApiBase}/driver/deliveries/${encodeURIComponent(
        context.deliveryId,
      )}/${action}`,
      {
        method: "PATCH",

        headers: {
          Accept:
            "application/json",

          Authorization:
            `Bearer ${context.token}`,
        },

        cache:
          "no-store",
      },
    );

  return readDriverMutationResponse(
    response,
    `No se pudo ejecutar la accion ${action}. HTTP ${response.status}.`,
  );
}

export async function acceptDriverDelivery(
  accessToken: string,
  deliveryId: string,
): Promise<DriverMutationResult> {
  return patchDriverDeliveryAction(
    accessToken,
    deliveryId,
    "accept",
  );
}

export async function pickupDriverDelivery(
  accessToken: string,
  deliveryId: string,
): Promise<DriverMutationResult> {
  return patchDriverDeliveryAction(
    accessToken,
    deliveryId,
    "pickup",
  );
}

export async function startDriverDelivery(
  accessToken: string,
  deliveryId: string,
): Promise<DriverMutationResult> {
  return patchDriverDeliveryAction(
    accessToken,
    deliveryId,
    "en-route",
  );
}

export async function arriveDriverDelivery(
  accessToken: string,
  deliveryId: string,
): Promise<DriverMutationResult> {
  return patchDriverDeliveryAction(
    accessToken,
    deliveryId,
    "arrive",
  );
}

export async function collectDriverCodCash(
  accessToken: string,
  deliveryId: string,
  cashReceivedAmount: number,
  idempotencyKey: string,
): Promise<DriverMutationResult> {
  const context =
    requireDriverMutationContext(
      accessToken,
      deliveryId,
    );

  if (
    !Number.isFinite(
      cashReceivedAmount,
    ) ||
    cashReceivedAmount < 0
  ) {
    throw new FlashApiError(
      400,
      "El monto recibido debe ser un numero valido.",
    );
  }

  const normalizedIdempotencyKey =
    idempotencyKey.trim();

  if (
    !DRIVER_IDEMPOTENCY_KEY_PATTERN.test(
      normalizedIdempotencyKey,
    )
  ) {
    throw new FlashApiError(
      400,
      "La clave de idempotencia del cobro no es valida.",
    );
  }

  const response =
    await fetch(
      `${flashApiBase}/driver/deliveries/${encodeURIComponent(
        context.deliveryId,
      )}/cash-collection`,
      {
        method: "POST",

        headers: {
          Accept:
            "application/json",

          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${context.token}`,

          "Idempotency-Key":
            normalizedIdempotencyKey,
        },

        body:
          JSON.stringify({
            cashReceivedAmount,
          }),

        cache:
          "no-store",
      },
    );

  return readDriverMutationResponse(
    response,
    `No se pudo registrar el cobro. HTTP ${response.status}.`,
  );
}

export async function deliverDriverDelivery(
  accessToken: string,
  deliveryId: string,
  pod: string,
): Promise<DriverMutationResult> {
  const context =
    requireDriverMutationContext(
      accessToken,
      deliveryId,
    );

  const normalizedPod =
    pod.trim();

  if (
    !/^[0-9]{4}$/.test(
      normalizedPod,
    )
  ) {
    throw new FlashApiError(
      400,
      "El codigo de entrega debe tener exactamente 4 digitos.",
    );
  }

  const response =
    await fetch(
      `${flashApiBase}/driver/deliveries/${encodeURIComponent(
        context.deliveryId,
      )}/deliver`,
      {
        method: "PATCH",

        headers: {
          Accept:
            "application/json",

          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${context.token}`,
        },

        body:
          JSON.stringify({
            pod:
              normalizedPod,
          }),

        cache:
          "no-store",
      },
    );

  return readDriverMutationResponse(
    response,
    `No se pudo completar la entrega. HTTP ${response.status}.`,
  );
}

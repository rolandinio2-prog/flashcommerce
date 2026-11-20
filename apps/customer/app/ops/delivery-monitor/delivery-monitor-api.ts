import {withReadDeadline} from '../../../lib/read-deadline';
import {parseMonitorRoute, parseMonitorSnapshot} from './delivery-monitor-contract';
export class MonitorAccessError extends Error {
  constructor(public status: number) { super(status === 401 ? 'Tu sesión venció. Inicia sesión en Operaciones.' : 'No tienes acceso al monitor de esta sucursal.'); }
}

import type {
  DeliveryMonitorSnapshot,
} from './delivery-monitor.types';

export interface GetDeliveryMonitorSnapshotInput {
  tenantCode: string;
  branchCode: string;
}

export interface DeliveryMonitorRealtimeSession {
  version: 'delivery-monitor.realtime-session.v1';
  topic: string;
  accessToken: string;
  expiresAt: string;
}

function requireInput(
  input: GetDeliveryMonitorSnapshotInput,
): {
  tenantCode: string;
  branchCode: string;
} {
  const tenantCode =
    input.tenantCode.trim();

  const branchCode =
    input.branchCode.trim();

  if (!tenantCode) {
    throw new Error(
      'tenantCode is required',
    );
  }

  if (!branchCode) {
    throw new Error(
      'branchCode is required',
    );
  }

  return {
    tenantCode,
    branchCode,
  };
}

export async function getDeliveryMonitorSnapshot(
  input: GetDeliveryMonitorSnapshotInput,
  options?: { stateOnly?: boolean; signal?: AbortSignal },
): Promise<DeliveryMonitorSnapshot> {
  const normalized =
    requireInput(input);

  const query =
    new URLSearchParams({
      tenant:
        normalized.tenantCode,

      branch:
        normalized.branchCode,
    });

  return withReadDeadline(async (signal) => {
  const response =
    await fetch(
      `/api/v1/ops/delivery-monitor/${options?.stateOnly ? "state" : "active"}?${query.toString()}`,
      {
        method:
          'GET',

        cache:
          'no-store',

        signal,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      },
    );

  if (response.status === 401 || response.status === 403) throw new MonitorAccessError(response.status);
  if (!response.ok) {
    throw new Error(
      `Delivery monitor request failed (${response.status})`,
    );
  }

  const payload =
    (await response.json()) as
      DeliveryMonitorSnapshot;

  return parseMonitorSnapshot(payload);
  }, {signal: options?.signal});
}

export async function getDeliveryMonitorRoute(
  input: GetDeliveryMonitorSnapshotInput & {
    deliveryId: string;
    signal?: AbortSignal;
  },
): Promise<DeliveryMonitorSnapshot['items'][number]['route']> {
  const normalized =
    requireInput(input);

  const deliveryId =
    input.deliveryId.trim();

  if (!deliveryId) {
    throw new Error(
      'Delivery id is required',
    );
  }

  const query = new URLSearchParams({
    tenant: normalized.tenantCode,
    branch: normalized.branchCode,
  });

  return withReadDeadline(async (signal) => {
  const response =
    await fetch(
      `/api/v1/ops/delivery-monitor/deliveries/${encodeURIComponent(
        deliveryId,
      )}/route?${query.toString()}`,
      {
        method: 'GET', signal,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      },
    );

  if (response.status === 401 || response.status === 403) throw new MonitorAccessError(response.status);
  if (!response.ok) {
    throw new Error(
      `Delivery monitor route request failed (${response.status})`,
    );
  }

  return parseMonitorRoute(await response.json());
  }, {signal: input.signal});
}
export async function getDeliveryMonitorRealtimeSession(
  input: GetDeliveryMonitorSnapshotInput,
  signal?: AbortSignal,
): Promise<DeliveryMonitorRealtimeSession> {
  const normalized =
    requireInput(input);

  const query =
    new URLSearchParams({
      tenant:
        normalized.tenantCode,

      branch:
        normalized.branchCode,
    });

  return withReadDeadline(async (readSignal) => {
  const response =
    await fetch(
      `/api/v1/ops/delivery-monitor/realtime-session?${query.toString()}`,
      {
        method:
          'POST',
        signal: readSignal,

        cache:
          'no-store',

        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      },
    );

  if (response.status === 401 || response.status === 403) throw new MonitorAccessError(response.status);
  if (!response.ok) {
    throw new Error(
      `Delivery monitor Realtime session request failed (${response.status})`,
    );
  }

  const payload =
    (await response.json()) as
      DeliveryMonitorRealtimeSession;

  if (
    payload.version !==
      'delivery-monitor.realtime-session.v1' ||
    typeof payload.topic !==
      'string' ||
    !payload.topic.startsWith(
      'delivery-monitor:',
    ) ||
    typeof payload.accessToken !==
      'string' ||
    !payload.accessToken ||
    typeof payload.expiresAt !==
      'string' ||
    !Number.isFinite(
      new Date(
        payload.expiresAt,
      ).getTime(),
    )
  ) {
    throw new Error(
      'Delivery monitor Realtime session contract is invalid',
    );
  }

  return payload;
  }, {signal});
}
import type {
  DeliveryMonitorMovementEvent,
} from './delivery-monitor.types';

export interface DeliveryMonitorRealtimeScope {
  tenantCode: string;
  branchCode: string;
}

export interface DeliveryMonitorRealtimeHandlers {
  onMovement(
    event: DeliveryMonitorMovementEvent,
  ): void;

  onReconnect(): void;

  onError(
    error: unknown,
  ): void;
}

export interface DeliveryMonitorRealtimeSubscription {
  close(): void;
}

export interface DeliveryMonitorRealtimeTransport {
  subscribe(
    scope: DeliveryMonitorRealtimeScope,
    handlers: DeliveryMonitorRealtimeHandlers,
  ): DeliveryMonitorRealtimeSubscription;
}

export function isNewerMovementEvent(
  incoming: DeliveryMonitorMovementEvent,
  previous: DeliveryMonitorMovementEvent | null,
): boolean {
  if (!previous) {
    return true;
  }

  if (incoming.sequence !== previous.sequence) {
    return incoming.sequence > previous.sequence;
  }

  return (
    new Date(incoming.capturedAt).getTime() >
    new Date(previous.capturedAt).getTime()
  );
}
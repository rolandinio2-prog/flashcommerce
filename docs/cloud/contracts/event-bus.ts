import type { CloudEventV1, TenantContext } from './index.js';
export type CloudEventTypeV1 = CloudEventV1['type'];
export type CloudEventHandler = (event: CloudEventV1) => void | Promise<void>;
export interface EventSubscription {
  readonly tenantId: string;
  readonly type: CloudEventTypeV1;
  readonly subscriberId: string;
}
export interface EventPublication {
  readonly eventId: string;
  readonly outcome: 'published' | 'duplicate';
  /** Number of successful deliveries from the original publication. */
  readonly delivered: number;
}
export interface EventBusPort {
  /** Runtime validation is mandatory before accepting decoded external payloads. */
  publish(context: TenantContext, event: unknown): Promise<EventPublication>;
}
export type EventErrorCode = 'INVALID_EVENT' | 'UNSUPPORTED_VERSION' | 'UNSUPPORTED_TYPE' | 'INVALID_SUBSCRIPTION' | 'DUPLICATE_SUBSCRIPTION' | 'EVENT_CONFLICT' | 'DELIVERY_IN_PROGRESS' | 'HANDLER_FAILED';
export class EventError extends Error {
  readonly name = 'EventError';
  constructor(readonly code: EventErrorCode, message: string) { super(message); }
}

import { type RealtimeChannel } from '@supabase/supabase-js';
import { RealtimeClient } from '@supabase/realtime-js';

import {
  getDeliveryMonitorRealtimeSession,
  MonitorAccessError,
} from './delivery-monitor-api';
import type {
  DeliveryMonitorMovementEvent,
} from './delivery-monitor.types';
import type {
  DeliveryMonitorRealtimeHandlers,
  DeliveryMonitorRealtimeScope,
  DeliveryMonitorRealtimeSubscription,
  DeliveryMonitorRealtimeTransport,
} from './delivery-monitor-realtime';

const TOKEN_REFRESH_MARGIN_MS =
  60_000;

interface SupabaseBroadcastEnvelope {
  payload?: unknown;
}

function readPublicConfiguration(): {
  url: string;
  key: string;
} {
  const url =
    process.env
      .NEXT_PUBLIC_SUPABASE_URL
      ?.trim();

  const key =
    (
      process.env
        .NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env
        .NEXT_PUBLIC_SUPABASE_ANON_KEY
    )
      ?.trim();

  if (!url || !key) {
    throw new Error(
      'Delivery monitor Realtime public configuration is missing',
    );
  }

  return {
    url,
    key,
  };
}

function parseMovementEvent(
  envelope: unknown,
): DeliveryMonitorMovementEvent | null {
  if (
    typeof envelope !==
      'object' ||
    envelope ===
      null
  ) {
    return null;
  }

  const payload =
    (
      envelope as
        SupabaseBroadcastEnvelope
    ).payload;

  if (
    typeof payload !==
      'object' ||
    payload ===
      null
  ) {
    return null;
  }

  const candidate =
    payload as
      Partial<DeliveryMonitorMovementEvent>;

  if (
    candidate.version !==
      'delivery-monitor.movement.v1' ||
    candidate.event !==
      'LOCATION_UPDATED' ||
    typeof candidate.deliveryId !==
      'string' ||
    !candidate.deliveryId ||
    typeof candidate.driverId !==
      'string' ||
    !candidate.driverId ||
    typeof candidate.latitude !==
      'number' ||
    !Number.isFinite(
      candidate.latitude,
    ) ||
    candidate.latitude <
      -90 ||
    candidate.latitude >
      90 ||
    typeof candidate.longitude !==
      'number' ||
    !Number.isFinite(
      candidate.longitude,
    ) ||
    candidate.longitude <
      -180 ||
    candidate.longitude >
      180 ||
    !(
      candidate.accuracyM ===
        null ||
      (
        typeof candidate.accuracyM ===
          'number' &&
        Number.isFinite(
          candidate.accuracyM,
        )
      )
    ) ||
    typeof candidate.capturedAt !==
      'string' ||
    !Number.isFinite(
      new Date(
        candidate.capturedAt,
      ).getTime(),
    ) ||
    typeof candidate.sequence !==
      'number' ||
    !Number.isSafeInteger(
      candidate.sequence,
    )
  ) {
    return null;
  }

  return candidate as
    DeliveryMonitorMovementEvent;
}

export function createDeliveryMonitorSupabaseRealtimeTransport(
): DeliveryMonitorRealtimeTransport {
  const {
    url,
    key,
  } =
    readPublicConfiguration();

  const realtimeEndpoint =
    `${url.replace(/\/+$/, '')}/realtime/v1`;

  const retryDelayMs =
    5_000;

  return {
    subscribe(
      scope:
        DeliveryMonitorRealtimeScope,
      handlers:
        DeliveryMonitorRealtimeHandlers,
    ): DeliveryMonitorRealtimeSubscription {
      console.info(
        '[DM_RT] EFFECT_ACTIVE',
      );

      const tenantCode =
        scope.tenantCode.trim();

      const branchCode =
        scope.branchCode.trim();

      if (
        !tenantCode ||
        !branchCode
      ) {
        throw new Error(
          'Delivery Monitor Realtime scope is required',
        );
      }

      let closed =
        false;

      let connectInFlight =
        false;

      let activeClient:
        RealtimeClient | null =
        null;

      let activeExpiresAt:
        string | null =
        null;

      let standbyClient:
        RealtimeClient | null =
        null;

      let blockedRetiringClient:
        RealtimeClient | null =
        null;

      let refreshTimer:
        ReturnType<typeof setTimeout> | null =
        null;

      function createRealtimeClient(): RealtimeClient {
        return new RealtimeClient(
          realtimeEndpoint,
          {
            params: {
              apikey:
                key,
            },
          },
        );
      }

      function clearRefreshTimer(): void {
        if (
          refreshTimer !==
          null
        ) {
          clearTimeout(
            refreshTimer,
          );

          refreshTimer =
            null;
        }
      }

      function scheduleRetry(): void {
        if (closed) {
          return;
        }

        clearRefreshTimer();

        console.info(
          '[DM_RT] HANDOVER_RETRY_SCHEDULED',
        );

        refreshTimer =
          setTimeout(
            () => {
              refreshTimer =
                null;

              if (closed) {
                return;
              }

              void connect();
            },
            retryDelayMs,
          );
      }

      function scheduleRefresh(
        expiresAt:
          string,
      ): void {
        if (closed) {
          return;
        }

        clearRefreshTimer();

        const expiresAtMs =
          new Date(
            expiresAt,
          ).getTime();

        const refreshDelayMs =
          Number.isFinite(
            expiresAtMs,
          )
            ? Math.max(
                1_000,
                (expiresAtMs - Date.now()) - Math.min(
                  TOKEN_REFRESH_MARGIN_MS, Math.max(1000, (expiresAtMs - Date.now()) / 2),
                ),
              )
            : 1_000;

        refreshTimer =
          setTimeout(
            () => {
              refreshTimer =
                null;

              if (closed) {
                return;
              }

              console.info(
                '[DM_RT] REFRESH_TRIGGERED',
              );

              void connect();
            },
            refreshDelayMs,
          );
      }

      async function retireBlockedClientBeforeHandover(): Promise<boolean> {
        const blockedClient =
          blockedRetiringClient;

        if (!blockedClient) {
          return true;
        }

        try {
          await blockedClient
            .removeAllChannels();

          if (
            blockedRetiringClient ===
            blockedClient
          ) {
            blockedRetiringClient =
              null;
          }

          console.info(
            '[DM_RT] BLOCKED_CLIENT_RETIRED',
          );

          return true;
        }
        catch {
          console.info(
            '[DM_RT] BLOCKED_CLIENT_RETIRE_FAILED',
          );

          return false;
        }
      }

      async function connect(): Promise<void> {
        if (
          closed ||
          connectInFlight
        ) {
          return;
        }

        connectInFlight =
          true;

        clearRefreshTimer();

        let candidateClient:
          RealtimeClient | null =
          null;

        try {
          const blockedRetired =
            await retireBlockedClientBeforeHandover();

          if (!blockedRetired) {
            scheduleRetry();
            return;
          }

          if (
            activeClient &&
            activeExpiresAt &&
            blockedRetiringClient ===
              null
          ) {
            const activeRefreshAtMs =
              new Date(
                activeExpiresAt,
              ).getTime() -
              TOKEN_REFRESH_MARGIN_MS;

            if (
              Number.isFinite(
                activeRefreshAtMs,
              ) &&
              Date.now() <
                activeRefreshAtMs
            ) {
              scheduleRefresh(
                activeExpiresAt,
              );

              return;
            }
          }

          console.info(
            '[DM_RT] SESSION_REQUEST_START',
          );

          const session =
            await getDeliveryMonitorRealtimeSession({
              tenantCode,
              branchCode,
            });

          console.info(
            '[DM_RT] SESSION_OK',
          );

          if (closed) {
            return;
          }

          if (activeClient) {
            console.info(
              '[DM_RT] HANDOVER_PREVIOUS_PRESERVED',
            );
          }

          const candidate =
            createRealtimeClient();

          candidateClient =
            candidate;

          standbyClient =
            candidate;

          console.info(
            '[DM_RT] STANDBY_CLIENT_CREATED',
          );

          await candidate
            .setAuth(
              session.accessToken,
            );

          console.info(
            '[DM_RT] STANDBY_AUTH_SET',
          );

          console.info(
            '[DM_RT] AUTH_SET',
          );

          if (closed) {
            throw new Error(
              'Delivery Monitor Realtime subscription closed',
            );
          }

          const candidateChannel =
            candidate.channel(
              session.topic,
              {
                config: {
                  private:
                    true,
                },
              },
            );

          console.info(
            '[DM_RT] STANDBY_CHANNEL_CREATED',
          );

          console.info(
            '[DM_RT] CHANNEL_CREATED',
          );

          const previousActiveToRetire =
            await new Promise<RealtimeClient | null>(
              (
                resolve,
                reject,
              ) => {
              let settled =
                false;

              candidateChannel
                .on(
                  'broadcast',
                  {
                    event:
                      'LOCATION_UPDATED',
                  },
                  (
                    envelope,
                  ) => {
                    console.info(
                      '[DM_RT] CALLBACK_LOCATION_UPDATED',
                    );

                    if (
                      closed ||
                      activeClient !==
                        candidate
                    ) {
                      return;
                    }

                    const movement =
                      parseMovementEvent(
                        envelope,
                      );

                    if (!movement) {
                      handlers.onError(
                        new Error(
                          'Invalid Delivery Monitor movement event',
                        ),
                      );

                      return;
                    }

                    handlers.onMovement(
                      movement,
                    );
                  },
                )
                .subscribe(
                  (
                    status,
                    _error,
                  ) => {
                    if (
                      status ===
                      'SUBSCRIBED'
                    ) {
                      if (settled) {
                        return;
                      }

                      settled =
                        true;

                      console.info(
                        '[DM_RT] SUBSCRIBE_SUBSCRIBED',
                      );

                      console.info(
                        '[DM_RT] STANDBY_SUBSCRIBED',
                      );

                      const previousActive =
                        activeClient;

                      activeClient =
                        candidate;

                      activeExpiresAt =
                        session.expiresAt;

                      if (
                        standbyClient ===
                        candidate
                      ) {
                        standbyClient =
                          null;
                      }

                      console.info(
                        '[DM_RT] ACTIVE_CLIENT_PROMOTED',
                      );

                      handlers.onReconnect();

                      resolve(
                        previousActive,
                      );

                      return;
                    }

                    if (
                      status ===
                      'CHANNEL_ERROR'
                    ) {
                      console.info(
                        '[DM_RT] SUBSCRIBE_CHANNEL_ERROR',
                      );
                    }

                    if (
                      status ===
                      'TIMED_OUT'
                    ) {
                      console.info(
                        '[DM_RT] SUBSCRIBE_TIMED_OUT',
                      );
                    }

                    if (
                      status ===
                        'CHANNEL_ERROR' ||
                      status ===
                        'TIMED_OUT'
                    ) {
                      if (settled) {
                        return;
                      }

                      settled =
                        true;

                      reject(
                        new Error(
                          `Delivery Monitor Realtime standby status: ${status}`,
                        ),
                      );

                      return;
                    }

                    if (
                      status ===
                        'CLOSED' &&
                      closed &&
                      !settled
                    ) {
                      settled =
                        true;

                      reject(
                        new Error(
                          'Delivery Monitor Realtime subscription closed',
                        ),
                      );
                    }
                  },
                );
              },
            );

          if (
            previousActiveToRetire &&
            previousActiveToRetire !==
              candidate
          ) {
            console.info(
              '[DM_RT] PREVIOUS_ACTIVE_RETIRE_START',
            );

            try {
              await previousActiveToRetire
                .removeAllChannels();

              console.info(
                '[DM_RT] PREVIOUS_ACTIVE_RETIRED',
              );
            }
            catch {
              blockedRetiringClient =
                previousActiveToRetire;

              console.info(
                '[DM_RT] PREVIOUS_ACTIVE_RETIRE_FAILED',
              );

              scheduleRetry();

              return;
            }
          }

          scheduleRefresh(
            session.expiresAt,
          );
        }
        catch (error) {
          if (error instanceof MonitorAccessError) {
            closed = true;
            clearRefreshTimer();
            const clients = new Set([activeClient, standbyClient, blockedRetiringClient, candidateClient]);
            activeClient = null; standbyClient = null; blockedRetiringClient = null; activeExpiresAt = null;
            for (const client of clients) { if (client) { try { await client.removeAllChannels(); } catch { /* Remain closed. */ } } }
            handlers.onError(error);
            return;
          }
          if (
            candidateClient &&
            activeClient !==
              candidateClient
          ) {
            console.info(
              '[DM_RT] STANDBY_FAILED',
            );

            if (
              standbyClient ===
              candidateClient
            ) {
              standbyClient =
                null;
            }

            try {
              await candidateClient
                .removeAllChannels();

              console.info(
                '[DM_RT] FAILED_STANDBY_RETIRED',
              );
            }
            catch {
              blockedRetiringClient =
                candidateClient;

              console.info(
                '[DM_RT] FAILED_STANDBY_RETIRE_FAILED',
              );
            }
          }

          if (
            !closed &&
            !activeClient
          ) {
            handlers.onError(
              new Error(
                'Delivery Monitor Realtime connection failed',
              ),
            );
          }

          if (!closed) {
            scheduleRetry();
          }
        }
        finally {
          connectInFlight =
            false;
        }
      }

      void connect();

      return {
        close(): void {
          if (closed) {
            return;
          }

          closed =
            true;

          clearRefreshTimer();

          const activeToClose =
            activeClient;

          const standbyToClose =
            standbyClient;

          const blockedToClose =
            blockedRetiringClient;

          activeClient =
            null;

          activeExpiresAt =
            null;

          standbyClient =
            null;

          blockedRetiringClient =
            null;

          void (
            async () => {
              if (activeToClose) {
                try {
                  await activeToClose
                    .removeAllChannels();
                }
                catch {
                  // Close is best-effort and must not reactivate transport.
                }
              }

              if (
                standbyToClose &&
                standbyToClose !==
                  activeToClose
              ) {
                try {
                  await standbyToClose
                    .removeAllChannels();
                }
                catch {
                  // Close is best-effort and must not reactivate transport.
                }
              }

              if (
                blockedToClose &&
                blockedToClose !==
                  activeToClose &&
                blockedToClose !==
                  standbyToClose
              ) {
                try {
                  await blockedToClose
                    .removeAllChannels();
                }
                catch {
                  // Close is best-effort and must not reactivate transport.
                }
              }
            }
          )();
        },
      };
    },
  };
}
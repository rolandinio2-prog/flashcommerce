import {onStaffLogout} from '../../../../lib/staff-session-lifecycle';
import {withReadDeadline} from '../../../../lib/read-deadline';
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
        ) && candidate.accuracyM >= 0
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
    ) || candidate.sequence < 0
  ) {
    return null;
  }

  return candidate as
    DeliveryMonitorMovementEvent;
}

export function createDeliveryMonitorSupabaseRealtimeTransport(): DeliveryMonitorRealtimeTransport {
  const disconnect = (client: RealtimeClient) => client.disconnect().catch(() => undefined);
  const {url,key} = readPublicConfiguration();
  return {subscribe(scope,handlers) {
    const tenantCode = scope.tenantCode.trim(), branchCode = scope.branchCode.trim();
    if (!tenantCode || !branchCode) throw new Error('Delivery Monitor Realtime scope is required');
    let closed = false, connecting = false;
    let active: RealtimeClient | null = null, standby: RealtimeClient | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingHandshakeReject: ((reason: Error) => void) | undefined;
    let sessionController: AbortController | null = null;
    const retiring = new Set<RealtimeClient>();
    let unsubscribeLogout = () => {};
    const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const schedule = (delay: number) => { clearTimer(); if (!closed) timer = setTimeout(() => { timer = undefined; void connect(); }, delay); };
    const report = (error: unknown) => { if (!closed) handlers.onError(error); };
    async function retire(client: RealtimeClient) {
      retiring.add(client);
      try {
        const statuses = await withReadDeadline(() => client.removeAllChannels(), {timeoutMs:5000});
        if (statuses.some(status => status !== 'ok')) return false;
        retiring.delete(client);
        return true;
      } catch { return false; }
      finally { void disconnect(client); }
    }
    async function connect() {
      if (closed || connecting) return;
      connecting = true;
      let candidate: RealtimeClient | null = null;
      try {
        for (const client of retiring) if (!await retire(client)) { report(new Error('No se pudo cerrar la conexión anterior.')); schedule(5000); return; }
        sessionController = new AbortController();
        const session = await getDeliveryMonitorRealtimeSession({tenantCode,branchCode},sessionController.signal);
        if (closed) return;
        candidate = new RealtimeClient(`${url.replace(/\/+$/, '')}/realtime/v1`, {params:{apikey:key}});
        standby = candidate;
        await withReadDeadline(() => candidate!.setAuth(session.accessToken));
        if (closed) return;
        const own = candidate;
        const channel = own.channel(session.topic,{config:{private:true}});
        const previous = await new Promise<RealtimeClient | null>((resolve,reject) => {
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
            handshakeTimer = undefined; pendingHandshakeReject = undefined;
            if (error) { reject(error); return; }
            const old = active; active = own; standby = null;
            handlers.onReconnect(); resolve(old);
          };
          pendingHandshakeReject = error => finish(error);
          handshakeTimer = setTimeout(() => finish(new Error('Tiempo de conexión Realtime agotado.')),15000);
          channel.on('broadcast',{event:'LOCATION_UPDATED'},envelope => {
            if (closed || active !== own) return;
            const movement = parseMovementEvent(envelope);
            if (movement) handlers.onMovement(movement);
            else report(new Error('Evento de ubicación inválido.'));
          }).subscribe(status => {
            if (closed) { finish(new Error('Conexión cerrada.')); return; }
            if (status === 'SUBSCRIBED') {
              if (!settled) finish();
              else if (active === own) handlers.onReconnect();
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              const error = new Error('La conexión de ubicación se interrumpió.');
              if (!settled) finish(error);
              else if (active === own) { report(error); schedule(5000); }
            }
          });
        });
        if (closed) return;
        if (previous && previous !== own && !await retire(previous)) { report(new Error('Cierre anterior pendiente.')); schedule(5000); return; }
        if (timer === undefined) schedule(Math.max(1000,Date.parse(session.expiresAt)-Date.now()-Math.min(TOKEN_REFRESH_MARGIN_MS,Math.max(1000,(Date.parse(session.expiresAt)-Date.now())/2))));
      } catch (error) {
        if (error instanceof MonitorAccessError) { handlers.onError(error); close(); return; }
        if (candidate && active !== candidate) { if (standby === candidate) standby = null; await retire(candidate); }
        if (!closed) { report(error); schedule(5000); }
      } finally {
        sessionController = null; connecting = false;
        if (closed && candidate) await retire(candidate);
      }
    }
    function close() {
      if (closed) return;
      closed = true; unsubscribeLogout(); clearTimer(); sessionController?.abort();
      pendingHandshakeReject?.(new Error('Conexión cerrada.'));
      if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
      const clients = new Set([...retiring,active,standby]); active=null; standby=null;
      for (const client of clients) if (client) {
        // Cancel socket reconnect immediately; channel leave acknowledgements may stall.
        void disconnect(client);
        void retire(client);
      }
    }
    unsubscribeLogout = onStaffLogout(close);
    void connect(); return {close};
  }};
}

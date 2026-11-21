import type { Page, WebSocket } from '@playwright/test';

interface TrackedSocket {
  socket: WebSocket;
  openedAt: number;
  closedAt: number | null;
  lastFrameAt: number | null;
}

/**
 * Observes the Supabase Realtime WebSockets opened by one page, natively
 * through Playwright (no injected scripts). Frame contents are never stored.
 */
export class RealtimeTracker {
  private readonly sockets: TrackedSocket[] = [];
  /** Probe markers we are waiting for -> times they were received. Only the marker match is kept. */
  private readonly probes = new Map<string, number>();

  constructor(page: Page) {
    page.on('websocket', socket => {
      if (!socket.url().includes('/realtime/v1')) return;
      const entry: TrackedSocket = { socket, openedAt: Date.now(), closedAt: null, lastFrameAt: null };
      this.sockets.push(entry);
      socket.on('framereceived', frame => {
        entry.lastFrameAt = Date.now();
        if (this.probes.size === 0) return;
        // Realtime v2 serializes broadcasts as binary frames; check both forms.
        const text = typeof frame.payload === 'string' ? frame.payload : Buffer.from(frame.payload).toString('utf8');
        for (const [marker, count] of this.probes) {
          // Marker is the probe's accuracy value; match it only as the accuracyM field.
          const field = new RegExp(`"accuracyM"\\s*:\\s*${marker.replace('.', '\\.')}(?![0-9])`);
          if (field.test(text)) this.probes.set(marker, count + 1);
        }
      });
      socket.on('close', () => { entry.closedAt = Date.now(); });
    });
  }

  get total(): number { return this.sockets.length; }

  /** Start counting frames that contain this probe marker. */
  watchProbe(marker: string): void { this.probes.set(marker, 0); }

  probeCount(marker: string): number { return this.probes.get(marker) ?? 0; }

  openCount(): number { return this.sockets.filter(s => s.closedAt === null).length; }

  /** Sockets opened at or after the given time. */
  openedSince(time: number): number { return this.sockets.filter(s => s.openedAt >= time).length; }

  /** Frames received (on any socket) at or after the given time. */
  framesSince(time: number): number {
    return this.sockets.filter(s => s.lastFrameAt !== null && s.lastFrameAt >= time).length;
  }

  lastCloseAt(): number {
    return Math.max(0, ...this.sockets.map(s => s.closedAt ?? 0));
  }
}

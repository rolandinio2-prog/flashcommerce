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

  constructor(page: Page) {
    page.on('websocket', socket => {
      if (!socket.url().includes('/realtime/v1')) return;
      const entry: TrackedSocket = { socket, openedAt: Date.now(), closedAt: null, lastFrameAt: null };
      this.sockets.push(entry);
      socket.on('framereceived', () => { entry.lastFrameAt = Date.now(); });
      socket.on('close', () => { entry.closedAt = Date.now(); });
    });
  }

  get total(): number { return this.sockets.length; }

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

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';

/**
 * Returns units held by unpaid PENDING orders whose hold expired.
 * A late payment or staff acceptance re-takes them (or flags SHORTAGE) in the DB trigger.
 */
@Injectable()
export class StockReservationExpiryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(StockReservationExpiryService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly databaseService: DatabaseService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.runOnce(), 60_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    const work = this.releaseExpired()
      .catch((error: unknown) => {
        // Idempotent: the next tick retries. Never stop releasing stock.
        this.logger.error(
          `STOCK_RESERVATION_EXPIRY_FAILED: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = work;
    return work;
  }

  private async releaseExpired(): Promise<void> {
    await this.databaseService.withTransaction(async (client) => {
      await client.query("set local lock_timeout='2s'");
      await client.query("set local statement_timeout='10s'");
      const lock = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_xact_lock(hashtext('stock_reservation_expiry_v1')) as acquired",
      );
      if (!lock.rows[0]?.acquired || this.stopped) return;
      const released = await client.query<{ orders: number }>(
        'select public.stock_release_expired_v1(100) as orders',
      );
      const orders = released.rows[0]?.orders ?? 0;
      if (orders > 0) this.logger.log(`STOCK_HOLDS_RELEASED orders=${orders}`);
    });
  }
}

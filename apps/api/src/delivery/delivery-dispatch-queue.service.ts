import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

// Read candidates in age order. The existing dispatcher revalidates the bundle
// and takes its usual driver-branch lock before creating any assignment.
export const WAITING_DELIVERY_CANDIDATES_SQL = `
  select d.id, d.tenant_id, d.branch_id, d.order_id, o.order_number
  from public.deliveries d
  join public.orders o on o.tenant_id=d.tenant_id and o.branch_id=d.branch_id and o.id=d.order_id
  join public.tenants t on t.id=d.tenant_id and t.status='ACTIVE'
  join public.branches b on b.tenant_id=d.tenant_id and b.id=d.branch_id and b.status='ACTIVE'
  where d.status='WAITING_ASSIGNMENT' and o.order_type='DELIVERY' and o.status='READY'
    and public.flashdelivery_bundle_dispatchable_v1(d.tenant_id,d.branch_id,d.id)
    and not exists (
      select 1 from public.delivery_assignments a
      where a.tenant_id=d.tenant_id and a.branch_id=d.branch_id and a.delivery_id=d.id
        and a.status in ('ASSIGNED','ACCEPTED')
    )
    and exists (
      select 1 from public.delivery_driver_branches db
      join public.delivery_drivers drv on drv.tenant_id=db.tenant_id and drv.id=db.driver_id
      where db.tenant_id=d.tenant_id and db.branch_id=d.branch_id
        and db.status='ENABLED' and drv.status='ACTIVE'
        and not exists (
          select 1 from public.delivery_assignments busy
          where busy.tenant_id=db.tenant_id and busy.branch_id=db.branch_id
            and busy.driver_id=drv.id and busy.status in ('ASSIGNED','ACCEPTED')
        )
    )
  order by d.created_at, d.id
  limit 20
  for update of d skip locked
`;

type WaitingDelivery = {
  id: string;
  tenant_id: string;
  branch_id: string;
  order_id: string;
  order_number: string;
};

@Injectable()
export class DeliveryDispatchQueueService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DeliveryDispatchQueueService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private paused = false;

  constructor(private readonly databaseService: DatabaseService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.runOnce();
    }, 5_000);
    this.timer.unref();
    void this.runOnce();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  runOnce(): Promise<void> {
    if (this.stopped || this.paused) return Promise.resolve();
    if (this.running) return this.running;
    const work = this.drain()
      .catch(() => {
        // Do not retry a failed/uncertain transaction automatically. The process
        // must be inspected and restarted before this worker can resume.
        this.paused = true;
        if (this.timer) clearInterval(this.timer);
        this.logger.error(
          'DELIVERY_DISPATCH_QUEUE_PAUSED: transaction failed; review required before restart',
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = work;
    return work;
  }

  private async drain(): Promise<void> {
    await this.databaseService.withTransaction(async (client) => {
      await client.query("set local lock_timeout='2s'");
      await client.query("set local statement_timeout='5s'");
      const lock = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_xact_lock(hashtext('flashdelivery_waiting_queue_v1')) as acquired",
      );
      if (!lock.rows[0]?.acquired || this.stopped) return;
      const candidates = await client.query<WaitingDelivery>(
        WAITING_DELIVERY_CANDIDATES_SQL,
      );
      for (const delivery of candidates.rows) {
        if (this.stopped) break;
        await client.query(
          `select public.flashdelivery_attempt_auto_dispatch_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::text)`,
          [
            delivery.tenant_id,
            delivery.branch_id,
            delivery.id,
            delivery.order_id,
            delivery.order_number,
            'WAITING_QUEUE',
          ],
        );
      }
    });
  }
}

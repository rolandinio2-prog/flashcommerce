import type { StaffSessionPrincipal } from '../core/staff/staff.types';
import {
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sign } from 'jsonwebtoken';

import { DeliveryMonitorService } from './delivery-monitor.service';

const REALTIME_SESSION_TTL_SECONDS = 300;

@Injectable()
export class DeliveryMonitorRealtimeSessionService {
  constructor(
    private readonly configService: ConfigService,

    private readonly deliveryMonitorService: DeliveryMonitorService,
  ) {}

  async createSession(principal: StaffSessionPrincipal): Promise<{
    version: 'delivery-monitor.realtime-session.v1';
    topic: string;
    accessToken: string;
    expiresAt: string;
  }> {
    // A topic belongs to one staff session, never to every browser in a branch.
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (
      ![
        principal.sessionId,
        principal.userId,
        principal.tenantId,
        principal.branchId,
      ].every((value) => typeof value === 'string' && uuid.test(value)) ||
      principal.passwordChangeRequired ||
      !['ADMIN', 'MANAGER', 'CASHIER'].includes(principal.role)
    ) {
      throw new UnauthorizedException('Session cannot access Realtime');
    }
    const scope = await this.deliveryMonitorService.resolveScope(
      principal.tenantCode,
      principal.branchCode,
    );

    if (
      scope.tenantId !== principal.tenantId ||
      scope.branchId !== principal.branchId
    ) {
      throw new ServiceUnavailableException('Session scope is inconsistent');
    }
    const ttl = Math.min(
      REALTIME_SESSION_TTL_SECONDS,
      Math.floor((Date.parse(principal.expiresAt) - Date.now()) / 1000),
    );
    if (!Number.isFinite(ttl) || ttl <= 0)
      throw new UnauthorizedException('Session expired');

    const jwtSecret = this.configService
      .get<string>('SUPABASE_JWT_SECRET')
      ?.trim();

    if (!jwtSecret) {
      throw new ServiceUnavailableException(
        'Delivery monitor Realtime signing is not configured',
      );
    }

    const topic = `delivery-monitor:${scope.tenantId}:${scope.branchId}:session:${principal.sessionId}`;

    const accessToken = sign(
      {
        role: 'authenticated',

        staff_session_id: principal.sessionId,
        dm_topic: topic,

        dm_tenant_id: scope.tenantId,

        dm_branch_id: scope.branchId,
      },
      jwtSecret,
      {
        algorithm: 'HS256',

        audience: 'authenticated',

        expiresIn: ttl,

        issuer: 'flashcommerce-api',

        subject: principal.userId,
      },
    );

    return {
      version: 'delivery-monitor.realtime-session.v1',

      topic,

      accessToken,

      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }
}

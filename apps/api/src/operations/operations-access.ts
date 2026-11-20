import {
  applyDecorators, BadRequestException, CallHandler, CanActivate, ExecutionContext, ForbiddenException,
  HttpException, Injectable, Logger, NestInterceptor, SetMetadata,
  UnauthorizedException, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, randomUUID } from 'node:crypto';
import { tap } from 'rxjs/operators';
import { StaffService } from '../staff/staff.service';
import type { StaffAuthenticatedRequest } from '../staff/staff.types';
import { OPERATION_KEY, OPERATIONS_POLICY, ORDER_STATUSES_BY_ROLE, type Operation } from './operations-policy';

type OperationRequest = StaffAuthenticatedRequest & {
  method: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  operationAudit?: { action: Operation; requestId: string };
};
const audit = new Logger('OperationsAudit');
const fingerprint = (value?: string) => value ? createHash('sha256').update(value).digest('hex').slice(0, 16) : null;

// No headers, URLs, bodies, GPS, tokens, customer data or raw internal IDs.
function record(request: OperationRequest, outcome: string, status: number) {
  audit.log(JSON.stringify({
    event: 'operations.access.v1', requestId: request.operationAudit?.requestId,
    action: request.operationAudit?.action ?? 'unmapped', outcome, status,
    actor: fingerprint(request.staff?.userId), session: fingerprint(request.staff?.sessionId),
    tenant: fingerprint(request.staff?.tenantId), branch: fingerprint(request.staff?.branchId),
    role: request.staff?.role ?? null,
  }));
}
@Injectable()
export class OperationsGuard implements CanActivate {
  constructor(private readonly staffService: StaffService, private readonly reflector: Reflector) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OperationRequest>();
    context.switchToHttp().getResponse<{setHeader(name: string, value: string): void}>().setHeader('Cache-Control', 'no-store');
    const action = this.reflector.getAllAndOverride<Operation>(OPERATION_KEY, [context.getHandler(), context.getClass()]);
    request.operationAudit = { action, requestId: randomUUID() };
    try {
      const token = this.staffService.readSessionToken(request.headers);
      const principal = token ? await this.staffService.resolveSession(token) : null;
      if (!principal || !principal.tenantId || !principal.branchId || !principal.tenantCode || !principal.branchCode ||
          !Number.isFinite(Date.parse(principal.expiresAt)) || Date.parse(principal.expiresAt) <= Date.now()) {
        throw new UnauthorizedException('Inicia sesión en Operaciones para continuar.');
      }
      request.staff = principal;
      if (principal.passwordChangeRequired || !action || !Object.prototype.hasOwnProperty.call(OPERATIONS_POLICY, action) ||
          !OPERATIONS_POLICY[action].roles.includes(principal.role)) {
        throw new ForbiddenException('Tu usuario no tiene permiso para esta acción.');
      }
      // Compatibility parameters may assert scope, but can never select it.
      for (const supplied of [request.query, request.body]) {
        for (const [key, expected] of [
          ['tenant', principal.tenantCode], ['tenantCode', principal.tenantCode],
          ['branch', principal.branchCode], ['branchCode', principal.branchCode],
          ['tenantId', principal.tenantId], ['branchId', principal.branchId],
        ]) {
          const value = supplied?.[key];
          if (value !== undefined && (typeof value !== 'string' || value.trim().toUpperCase() !== expected.toUpperCase())) {
            throw new ForbiddenException('El alcance no corresponde a tu sesión.');
          }
        }
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        const header = (name: string) => typeof request.headers[name] === 'string' ? request.headers[name] as string : '';
        const origin = header('origin');
        const allowed = new Set([
          ...(process.env.FLASH_ALLOWED_ORIGINS || '').split(','), process.env.FLASH_CUSTOMER_URL || '',
          ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
        ].map(value => value.trim()).filter(Boolean));
        // Cookies require trusted Origin. Bearer clients still pass identical
        // session, role and scope checks; a shared key cannot bypass them.
        const bearer = header('authorization').startsWith('Bearer ');
        if (header('content-type').split(';')[0].trim().toLowerCase() !== 'application/json' ||
            header('sec-fetch-site') === 'cross-site' || (origin ? !allowed.has(origin) : !bearer)) {
          throw new ForbiddenException('Origen de solicitud no permitido.');
        }
      }
      if (action === 'orders.status') {
        const status = request.body?.status;
        if (typeof status !== 'string' || !status.trim()) throw new BadRequestException('Indica un estado válido.');
        if (!ORDER_STATUSES_BY_ROLE[principal.role]?.includes(status.trim().toUpperCase())) {
          throw new ForbiddenException('Tu rol no puede realizar este cambio de estado.');
        }
      }
      return true;
    } catch (error) {
      record(request, 'DENIED', error instanceof HttpException ? error.getStatus() : 500);
      throw error;
    }
  }
}
@Injectable()
export class OperationsAuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<OperationRequest>();
    return next.handle().pipe(tap({
      next: () => record(request, 'COMPLETED', context.switchToHttp().getResponse<{statusCode: number}>().statusCode),
      error: (error: unknown) => record(request, 'FAILED', error instanceof HttpException ? error.getStatus() : 500),
    }));
  }
}
export const OperationsAccess = () => applyDecorators(
  UseGuards(OperationsGuard), UseInterceptors(OperationsAuditInterceptor),
);
export const OperationPermission = (action: Operation) => SetMetadata(OPERATION_KEY, action);

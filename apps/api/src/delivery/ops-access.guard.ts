import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class OpsAccessGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configuredKey =
      this.configService.get<string>('OPS_ACCESS_KEY')?.trim() || '';

    if (configuredKey.length < 48) {
      throw new ServiceUnavailableException(
        'Operations access is not configured',
      );
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();

    const headerValue = request.headers['x-ops-key'];

    const receivedKey = (
      Array.isArray(headerValue)
        ? headerValue[0]
        : headerValue || ''
    ).trim();

    const configuredBuffer = Buffer.from(configuredKey, 'utf8');
    const receivedBuffer = Buffer.from(receivedKey, 'utf8');

    const validKey =
      configuredBuffer.length === receivedBuffer.length &&
      timingSafeEqual(configuredBuffer, receivedBuffer);

    if (!validKey) {
      throw new UnauthorizedException(
        'Invalid operations credentials',
      );
    }

    return true;
  }
}
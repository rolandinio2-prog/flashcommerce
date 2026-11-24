import {
  Body,
  Controller,
  Headers,
  Post,
  Res,
  NotFoundException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { DraftService } from './draft.service';
import {
  draftCookieName,
  draftCookieOptions,
  readDraftCookie,
} from './draft-cookie';
import { secret } from './draft-validation';
@Controller('checkout-drafts')
export class DraftController {
  constructor(private readonly drafts: DraftService) {}
  @Post('save')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async save(
    @Body() body: Record<string, unknown>,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.drafts.save(body, cookie);
    response.cookie(
      draftCookieName(body.tenant, body.branch),
      secret(body.secret),
      draftCookieOptions(result.expiresAt),
    );
    return result;
  }
  @Post('restore')
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  async restore(
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.drafts.restore(body);
    response.cookie(
      draftCookieName(body.tenant, body.branch),
      secret(body.secret),
      draftCookieOptions(result.expiresAt),
    );
    return result;
  }
  @Post('session')
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  async session(
    @Body() body: Record<string, unknown>,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const token = readDraftCookie(cookie, body?.tenant, body?.branch);
    if (!token) throw new NotFoundException('No hay borrador en esta sesión.');
    const draft = await this.drafts.restore({
      tenant: body.tenant,
      branch: body.branch,
      secret: token,
    });
    return { draft, secret: token };
  }
  @Post('mine')
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  mine(
    @Body() body: Record<string, unknown>,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.drafts.list(body, cookie);
  }
}

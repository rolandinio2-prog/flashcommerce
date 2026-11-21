import helmet from 'helmet';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());

  app.setGlobalPrefix('api/v1');

  const nodeEnvironment = (process.env.NODE_ENV || '').trim().toLowerCase();

  const configuredOrigins = [
    ...(process.env.FLASH_ALLOWED_ORIGINS || '').split(','),
    process.env.FLASH_CUSTOMER_URL || '',
  ]
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const allowedOrigins = new Set(configuredOrigins);

  if (nodeEnvironment !== 'production') {
    allowedOrigins.add('http://localhost:3000');
  }

  if (nodeEnvironment === 'production' && allowedOrigins.size === 0) {
    throw new Error('FLASH_ALLOWED_ORIGINS is required in production');
  }

  app.enableCors({
    origin(
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Cashier-Key',
      'X-Payment-Lab-Key',
      'X-Ops-Key',
    ],
    maxAge: 600,
  });

  const port = process.env.PORT ?? 3001;

  await app.listen(port);

  console.log(`Flash Commerce API running on http://localhost:${port}`);
}

void bootstrap();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');

  const customerUrl =
    process.env.FLASH_CUSTOMER_URL?.trim() ||
    'http://localhost:3000';

  app.enableCors({
    origin: ['http://localhost:3000', customerUrl],
    credentials: true,
  });

  const port = process.env.PORT ?? 3001;

  await app.listen(port);

  console.log(`Flash Commerce API running on http://localhost:${port}`);
}

bootstrap();
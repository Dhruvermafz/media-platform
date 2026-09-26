import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  // Behind NGINX/an ingress every request arrives from the proxy's IP. Without
  // this, RateLimitGuard's per-IP fallback (login, public share links) would
  // put every anonymous visitor in one shared bucket.
  app.set('trust proxy', 1);
  app.useLogger(app.get(PinoLogger));

  const config = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown properties
      forbidNonWhitelisted: true, // ...and reject requests that had them, rather than silently dropping
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableCors();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Distributed Media Processing Platform API')
    .setDescription('Upload, process, and track media assets. See /health and /metrics for ops.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  // Let in-flight requests finish, close DB/Redis connections cleanly
  // (handled in each service's onModuleDestroy) instead of dropping
  // connections mid-request on SIGTERM — matters for zero-downtime
  // rolling deploys in Kubernetes.
  app.enableShutdownHooks();

  const port = config.get<number>('port')!;
  await app.listen(port);
  new Logger('Bootstrap').log(`API listening on :${port} (docs at /docs)`);
}

bootstrap();

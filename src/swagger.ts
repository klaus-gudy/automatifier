import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Where the UI is served. `${SWAGGER_PATH}-json` serves the raw OpenAPI document. */
export const SWAGGER_PATH = 'docs';

/**
 * Mounts the OpenAPI docs.
 *
 * Its own file rather than twenty lines in `main.ts`, so bootstrap stays a list
 * of things that happen and this stays the one place that decides what the docs
 * say.
 *
 * Worth being honest about what this can and cannot document: OpenAPI describes
 * HTTP, so nothing this service consumes from or publishes to RabbitMQ appears
 * below. Register an event class with `extraModels` when there is one worth
 * publishing the shape of — it belongs to no route, so nothing would otherwise
 * pull it into the document. AsyncAPI is the specification that covers
 * message-driven interfaces properly, if this grows enough to want it.
 */
export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Automatifier')
    .setVersion('0.0.1')
    .addTag('health', 'Liveness and dependency probing')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [],
  });

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    swaggerOptions: {
      // Keeps the tried-out endpoint and expansion state across a reload.
      persistAuthorization: true,
    },
  });
}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { LoggingInterceptor } from '@/common/interceptors/logging.interceptor';
import appConfig from '@/config/app.config';
import databaseConfig from '@/config/database.config';
import rabbitmqConfig from '@/config/rabbitmq.config';
import { DatabaseModule } from '@/database/database.module';
import { HealthModule } from '@/modules/health/health.module';
import { LeasesModule } from '@/modules/leases/leases.module';

/**
 * The root module wires features together and owns no logic of its own.
 *
 * `MessagingModule` is deliberately absent: it is infrastructure, imported by
 * the features that need it rather than made global, which keeps the dependency
 * visible in the feature module instead of arriving invisibly. `DatabaseModule`
 * *is* here, because `TypeOrmModule.forRoot` has to be registered once at the
 * root — features then reach the pool through `TypeOrmModule.forFeature([...])`.
 *
 * Every config namespace is loaded centrally below regardless, because
 * `ConfigModule.forRoot` is where each one has to be registered before any
 * module can inject it with `forFeature`.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, rabbitmqConfig],
      envFilePath: '.env',
      // Read once at boot rather than off `process.env` on every access.
      cache: true,
    }),
    DatabaseModule,
    HealthModule,
    LeasesModule,
  ],
  providers: [
    /*
     * Registered through `APP_INTERCEPTOR` rather than
     * `app.useGlobalInterceptors()` in `main.ts`, so it goes through the DI
     * container — which is what lets it inject `ConfigService` to decide
     * whether request bodies are logged.
     */
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}

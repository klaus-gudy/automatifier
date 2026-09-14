import { Module } from '@nestjs/common';

import { DatabaseModule } from '@/database/database.module';
import { MessagingModule } from '@/messaging/messaging.module';
import { HealthController } from '@/modules/health/health.controller';

/**
 * Imports the infrastructure modules purely to reach the same singletons every
 * feature module already uses — Nest shares a module's providers across every
 * module that imports it, so this opens no second connection to either.
 */
@Module({
  imports: [DatabaseModule, MessagingModule],
  controllers: [HealthController],
})
export class HealthModule {}

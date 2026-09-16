import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import leaseConfig from '@/config/lease.config';
import { LeaseExpiryScanService } from '@/modules/leases/lease-expiry-scan.service';
import { LeaseReminder } from '@/modules/leases/lease-reminder.entity';
import { LeaseReminderService } from '@/modules/leases/lease-reminder.service';
import { Lease } from '@/modules/leases/lease.entity';
import { LeasesController } from '@/modules/leases/leases.controller';
import { LeasesService } from '@/modules/leases/leases.service';

@Module({
  imports: [
    ConfigModule.forFeature(leaseConfig),
    // `Lease` is jarvis's, read-only; `LeaseReminder` is this service's own.
    // Same connection, different schemas — each entity says which.
    TypeOrmModule.forFeature([Lease, LeaseReminder]),
  ],
  controllers: [LeasesController],
  providers: [LeasesService, LeaseReminderService, LeaseExpiryScanService],
})
export class LeasesModule {}

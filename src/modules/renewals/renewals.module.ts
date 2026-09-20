import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import leaseConfig from '@/config/lease.config';
import { MessagingModule } from '@/messaging/messaging.module';
import { Lease } from '@/modules/leases/lease.entity';
import { RenewalScanService } from '@/modules/renewals/renewal-scan.service';
import { RenewalsController } from '@/modules/renewals/renewals.controller';
import { RenewalsService } from '@/modules/renewals/renewals.service';

@Module({
  imports: [
    // For the time zone days overdue are counted in — the reminders' zone.
    ConfigModule.forFeature(leaseConfig),
    TypeOrmModule.forFeature([Lease]),
    // Imported here, not global, as in `LeasesModule`.
    MessagingModule,
  ],
  controllers: [RenewalsController],
  providers: [RenewalsService, RenewalScanService],
})
export class RenewalsModule {}

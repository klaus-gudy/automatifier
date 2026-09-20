import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import leaseConfig from '@/config/lease.config';
import { MessagingModule } from '@/messaging/messaging.module';
import { Lease } from '@/modules/leases/lease.entity';
import { RenewalEventSweeperService } from '@/modules/renewals/renewal-event-sweeper.service';
import { RenewalEvent } from '@/modules/renewals/renewal-event.entity';
import { RenewalEventService } from '@/modules/renewals/renewal-event.service';
import { RenewalScanService } from '@/modules/renewals/renewal-scan.service';
import { RenewalsController } from '@/modules/renewals/renewals.controller';
import { RenewalsService } from '@/modules/renewals/renewals.service';

@Module({
  imports: [
    // For the time zone days overdue are counted in — the reminders' zone.
    ConfigModule.forFeature(leaseConfig),
    // `Lease` is jarvis's, read-only; `RenewalEvent` is this service's own.
    TypeOrmModule.forFeature([Lease, RenewalEvent]),
    // Imported here, not global, as in `LeasesModule`.
    MessagingModule,
  ],
  controllers: [RenewalsController],
  providers: [
    RenewalsService,
    RenewalEventService,
    RenewalScanService,
    RenewalEventSweeperService,
  ],
})
export class RenewalsModule {}

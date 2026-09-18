import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import leaseConfig from '@/config/lease.config';
import { Lease } from '@/modules/leases/lease.entity';
import { RenewalsController } from '@/modules/renewals/renewals.controller';
import { RenewalsService } from '@/modules/renewals/renewals.service';

@Module({
  imports: [
    // For the time zone days overdue are counted in — the reminders' zone.
    ConfigModule.forFeature(leaseConfig),
    TypeOrmModule.forFeature([Lease]),
  ],
  controllers: [RenewalsController],
  providers: [RenewalsService],
})
export class RenewalsModule {}

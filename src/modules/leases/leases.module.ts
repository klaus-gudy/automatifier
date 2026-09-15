import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import leaseConfig from '@/config/lease.config';
import { Lease } from '@/modules/leases/lease.entity';
import { LeasesController } from '@/modules/leases/leases.controller';
import { LeasesService } from '@/modules/leases/leases.service';

@Module({
  imports: [
    ConfigModule.forFeature(leaseConfig),
    TypeOrmModule.forFeature([Lease]),
  ],
  controllers: [LeasesController],
  providers: [LeasesService],
})
export class LeasesModule {}

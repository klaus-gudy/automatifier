import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Lease } from '@/modules/leases/lease.entity';
import { LeasesController } from '@/modules/leases/leases.controller';
import { LeasesService } from '@/modules/leases/leases.service';

@Module({
  imports: [TypeOrmModule.forFeature([Lease])],
  controllers: [LeasesController],
  providers: [LeasesService],
})
export class LeasesModule {}

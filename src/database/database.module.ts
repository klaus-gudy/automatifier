import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import appConfig from '@/config/app.config';
import databaseConfig from '@/config/database.config';
import { DatabaseHealthService } from '@/database/database-health.service';
import { buildDataSourceOptions } from '@/database/typeorm.config';

/**
 * Infrastructure, not a feature. It owns the connection pool and the health
 * probe over it; entities and repositories belong to the feature modules that
 * define them, each calling `TypeOrmModule.forFeature([...])` for its own.
 */
@Module({
  imports: [
    // Makes `appConfig.KEY` injectable here, for `DatabaseHealthService`'s
    // probe timeout.
    ConfigModule.forFeature(appConfig),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule.forFeature(databaseConfig)],
      inject: [databaseConfig.KEY],
      useFactory: (config: ConfigType<typeof databaseConfig>) =>
        buildDataSourceOptions(config),
    }),
  ],
  providers: [DatabaseHealthService],
  exports: [DatabaseHealthService],
})
export class DatabaseModule {}

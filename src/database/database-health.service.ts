import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { DependencyHealth, withTimeout } from '@/common/dependency-health';
import appConfig from '@/config/app.config';

/**
 * Probes Postgres for the health endpoint.
 *
 * `SELECT 1` rather than `dataSource.isInitialized`: the flag says a pool was
 * built at boot, not that the database is answering now. A database that died
 * an hour ago leaves that flag `true`, which is exactly the failure a health
 * check exists to catch.
 */
@Injectable()
export class DatabaseHealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async checkHealth(): Promise<DependencyHealth> {
    if (!this.dataSource.isInitialized) {
      return { status: 'down', error: 'data source is not initialized' };
    }

    const startedAt = Date.now();
    try {
      await withTimeout(
        this.dataSource.query('SELECT 1'),
        this.config.healthProbeTimeoutMs,
      );
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (cause) {
      return {
        status: 'down',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }
}

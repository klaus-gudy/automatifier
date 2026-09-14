import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { DatabaseHealthService } from '@/database/database-health.service';
import { RabbitmqService } from '@/messaging/rabbitmq.service';
import { HealthResponseDto } from '@/modules/health/dto/health-response.dto';

/**
 * Liveness plus a live probe of every dependency.
 *
 * **Read this as a combined liveness+readiness probe, and know what that
 * costs.** A platform pointed at this will restart the process on any database
 * or broker blip, including ones that recover on their own in seconds. The
 * broker connection reconnects by itself (see `RabbitmqService`), so a restart
 * on that count is usually unnecessary; if that becomes a problem, split this
 * into a liveness route that always answers `ok` and a readiness route that
 * does what this one does.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseHealthService,
    private readonly rabbitmq: RabbitmqService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness + dependency check',
    description:
      'Reports process uptime plus a live probe of Postgres and RabbitMQ. ' +
      'Returns 503 if either is down.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: HealthResponseDto })
  @ApiServiceUnavailableResponse({
    description: 'Postgres or RabbitMQ is unreachable.',
    type: HealthResponseDto,
  })
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthResponseDto> {
    // Run together, not one after another: two independent dependencies have
    // no reason to make each other's timeout additive.
    const [database, rabbitmq] = await Promise.all([
      this.database.checkHealth(),
      this.rabbitmq.checkHealth(),
    ]);

    // "disabled" is a deliberate configuration, not a fault, so it does not
    // degrade the service.
    const degraded = database.status === 'down' || rabbitmq.status === 'down';

    res.status(degraded ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK);

    return {
      status: degraded ? 'degraded' : 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      checks: { database, rabbitmq },
    };
  }
}

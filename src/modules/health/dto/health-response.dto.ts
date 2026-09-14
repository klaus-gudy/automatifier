import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';

/**
 * One dependency's probe result. A discriminated union rather than a single
 * shape with optional fields, so `error` cannot appear on an "up" result and
 * `latencyMs` cannot appear on a "down" one — the states genuinely carry
 * different information, not the same shape with gaps.
 */
export class DependencyUpDto {
  @ApiProperty({ example: 'up', enum: ['up'] })
  status: 'up';

  @ApiProperty({ example: 12, description: 'Round-trip time of the probe.' })
  latencyMs: number;
}

export class DependencyDownDto {
  @ApiProperty({ example: 'down', enum: ['down'] })
  status: 'down';

  @ApiProperty({ example: 'timed out after 2000ms' })
  error: string;
}

/** Switched off by configuration. Not a failure, so it never degrades health. */
export class DependencyDisabledDto {
  @ApiProperty({ example: 'disabled', enum: ['disabled'] })
  status: 'disabled';
}

@ApiExtraModels(DependencyUpDto, DependencyDownDto, DependencyDisabledDto)
export class DependencyChecksDto {
  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(DependencyUpDto) },
      { $ref: getSchemaPath(DependencyDownDto) },
    ],
  })
  database: DependencyUpDto | DependencyDownDto;

  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(DependencyUpDto) },
      { $ref: getSchemaPath(DependencyDownDto) },
      { $ref: getSchemaPath(DependencyDisabledDto) },
    ],
  })
  rabbitmq: DependencyUpDto | DependencyDownDto | DependencyDisabledDto;
}

export class HealthResponseDto {
  @ApiProperty({
    example: 'ok',
    enum: ['ok', 'degraded'],
    description:
      '"degraded" when any dependency below reports "down". The process ' +
      'itself is still up — this is not a crash report.',
  })
  status: 'ok' | 'degraded';

  @ApiProperty({
    example: 42,
    description: 'Seconds since this process started.',
  })
  uptimeSeconds: number;

  @ApiProperty({ type: DependencyChecksDto })
  checks: DependencyChecksDto;
}

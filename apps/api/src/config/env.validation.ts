import { plainToInstance } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min, validateSync } from 'class-validator';

class EnvVars {
  @IsOptional()
  @IsIn(['development', 'production', 'test'])
  NODE_ENV?: string;

  @IsOptional()
  @IsInt()
  PORT?: number;

  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsNotEmpty()
  REDIS_URL!: string;

  @IsNotEmpty()
  @IsString()
  JWT_SECRET!: string;

  @IsNotEmpty()
  S3_ENDPOINT!: string;

  @IsNotEmpty()
  S3_ACCESS_KEY!: string;

  @IsNotEmpty()
  S3_SECRET_KEY!: string;

  @IsNotEmpty()
  S3_BUCKET!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  RATE_LIMIT_MAX_REQUESTS?: number;
}

/** Runs once at boot (see main.ts). Fails fast with a readable error
 * instead of letting the app start and die confusingly on first request. */
export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvVars, config, { enableImplicitConversion: true });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const messages = errors.map((e) => Object.values(e.constraints ?? {}).join(', ')).join('; ');
    throw new Error(`Invalid environment configuration: ${messages}`);
  }
  return validated;
}

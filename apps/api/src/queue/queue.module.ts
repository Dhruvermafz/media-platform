import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { JobProducerService } from './job-producer.service';
import { RetrySchedulerService } from './retry-scheduler.service';

@Global()
@Module({
  providers: [RedisService, JobProducerService, RetrySchedulerService],
  exports: [RedisService, JobProducerService],
})
export class QueueModule {}

import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [JobsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}

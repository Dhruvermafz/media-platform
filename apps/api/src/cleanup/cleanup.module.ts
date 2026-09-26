import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { CleanupService } from './cleanup.service';

@Module({ imports: [AssetsModule], providers: [CleanupService] })
export class CleanupModule {}

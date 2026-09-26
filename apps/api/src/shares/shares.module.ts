import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { PublicSharesController, SharesController } from './shares.controller';
import { SharesService } from './shares.service';

@Module({ imports: [AssetsModule], controllers: [SharesController, PublicSharesController], providers: [SharesService] })
export class SharesModule {}

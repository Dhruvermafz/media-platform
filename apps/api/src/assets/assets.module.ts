import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetPresenter } from './asset.presenter';

@Module({
  controllers: [AssetsController],
  providers: [AssetsService, AssetPresenter],
  exports: [AssetsService, AssetPresenter],
})
export class AssetsModule {}

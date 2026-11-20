import { DraftController } from './draft.controller';
import { DraftService } from './draft.service';
import { Module } from '@nestjs/common';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

@Module({
  controllers: [CartController, DraftController],
  providers: [CartService, DraftService],
})
export class CartModule {}
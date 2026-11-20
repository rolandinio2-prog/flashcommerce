import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CartService } from './cart.service';

interface CreateCartBody {
  tenantCode?: string;
  branchCode?: string;
}

interface AddCartItemBody {
  productId?: string;
  quantity?: number;
  riceChoice?: string;
}

interface UpdateCartItemBody {
  quantity?: number;
  riceChoice?: string;
}

@Controller('carts')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Post()
  createCart(@Body() body: CreateCartBody) {
    return this.cartService.createCart(
      body?.tenantCode,
      body?.branchCode,
    );
  }

  @Post(':cartToken/items')
  addItem(
    @Param('cartToken') cartToken: string,
    @Body() body: AddCartItemBody,
  ) {
    return this.cartService.addItem(
      cartToken,
      body?.productId,
      body?.quantity,
      body?.riceChoice,
    );
  }

  @Get(':cartToken')
  getCart(
    @Param('cartToken') cartToken: string,
  ) {
    return this.cartService.getCart(cartToken);
  }

  @Patch(':cartToken/items/:productId')
    updateItem(
    @Param('cartToken') cartToken: string,
    @Param('productId') productId: string,
    @Body() body: UpdateCartItemBody,
    ) {
    return this.cartService.updateItem(
        cartToken,
        productId,
        body?.quantity,
      body?.riceChoice,
    );
    }

  @Delete(':cartToken/items/:productId')
    removeItem(
    @Param('cartToken') cartToken: string,
    @Param('productId') productId: string,
    @Query('riceChoice') rice: string | undefined,
    ) {
    return this.cartService.removeItem(
        cartToken,
        productId,
        rice,
    );
}
}
import { Body,Controller,Get,Param,ParseUUIDPipe,Post,Req,UseGuards } from '@nestjs/common';
import { RecoveryRequestGuard } from './recovery-request.guard';
import { OperationsAccess,OperationPermission } from '../operations/operations-access';
import type { StaffAuthenticatedRequest } from '../staff/staff.types';
import type { PosCheckoutInput } from './pos-checkout';
import { OpsPosService } from './ops-pos.service';

@Controller('ops/pos')
@OperationsAccess()
export class OpsPosController {
  constructor(private readonly pos:OpsPosService){}
  @Get('catalog') @OperationPermission('orders.create')
  catalog(@Req() req:StaffAuthenticatedRequest){return this.pos.catalogFor(req.staff);}
  @Get('current') @OperationPermission('orders.create')
  current(@Req() req:StaffAuthenticatedRequest){return this.pos.current(req.staff);}
  @Post('drafts') @UseGuards(RecoveryRequestGuard) @OperationPermission('orders.create')
  draft(@Req() req:StaffAuthenticatedRequest,@Body() body:{requestId?:string}){return this.pos.createDraft(req.staff,body?.requestId);}
  @Post('drafts/:token/items/:action') @UseGuards(RecoveryRequestGuard) @OperationPermission('orders.create')
  item(@Req() req:StaffAuthenticatedRequest,@Param('token',new ParseUUIDPipe()) token:string,@Param('action') action:string,@Body() body:{productId?:string;quantity?:number;riceChoice?:string}){
    if(action!=='add'&&action!=='set'&&action!=='remove')return this.pos.mutate(req.staff,token,{},'add');
    return this.pos.mutate(req.staff,token,body,action);
  }
  @Post('checkout') @UseGuards(RecoveryRequestGuard) @OperationPermission('orders.create')
  checkout(@Req() req:StaffAuthenticatedRequest,@Body() body:PosCheckoutInput){return this.pos.checkout(req.staff,body);}
  @Post('orders/:id/qr') @UseGuards(RecoveryRequestGuard) @OperationPermission('payments.settle')
  qr(@Req() req:StaffAuthenticatedRequest,@Param('id',new ParseUUIDPipe()) id:string,@Body() body:{phone?:string}){return this.pos.qr(req.staff,id,body?.phone);}
  @Get('orders/:id/payment') @OperationPermission('payments.read')
  payment(@Req() req:StaffAuthenticatedRequest,@Param('id',new ParseUUIDPipe()) id:string){return this.pos.payment(req.staff,id);}
}

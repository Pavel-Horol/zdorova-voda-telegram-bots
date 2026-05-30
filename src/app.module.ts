import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { PricingSettingsModule } from './modules/pricing-settings/pricing-settings.module';
import { ClientsModule } from './modules/clients/clients.module';
import { OrdersModule } from './modules/orders/orders.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    PricingModule,
    PricingSettingsModule,
    ClientsModule,
    OrdersModule,
  ],
})
export class AppModule {}

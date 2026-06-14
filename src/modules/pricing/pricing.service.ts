import { Injectable } from '@nestjs/common';

/**
 * Набор цен, нужный для расчёта суммы заказа.
 * Структурно совместим с моделью PriceSettings (id/updatedAt не используются).
 */
export interface PriceList {
  price1: number;
  priceFrom2: number;
  priceFrom6: number;
  depositPerBottle: number;
  pumpPrice: number;
  waterStartPrice: number;
}

@Injectable()
export class PricingService {
  /**
   * Считает итоговую сумму заказа (PRODUCT.md «Расчёт суммы»).
   *
   * Первый заказ — стартовый комплект (раскладка): bottles × залог + помпа +
   * bottles × старт-вода. Повторный — bottles × цена по сетке воды 1 / от 2 / от 6.
   *
   * @throws Error если bottles не целое положительное число (0 бутылей — не заказ).
   */
  calculateTotal(
    bottles: number,
    isFirstOrder: boolean,
    prices: PriceList,
  ): number {
    if (!Number.isInteger(bottles) || bottles < 1) {
      throw new Error(`bottles must be a positive integer, got: ${bottles}`);
    }

    if (isFirstOrder) {
      return (
        bottles * prices.depositPerBottle +
        prices.pumpPrice +
        bottles * prices.waterStartPrice
      );
    }

    let perBottle: number;
    if (bottles === 1) {
      perBottle = prices.price1;
    } else if (bottles < 6) {
      perBottle = prices.priceFrom2;
    } else {
      perBottle = prices.priceFrom6;
    }

    return bottles * perBottle;
  }
}

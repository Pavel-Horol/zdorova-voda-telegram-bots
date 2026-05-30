import { Injectable } from '@nestjs/common';

/**
 * Набор цен, нужный для расчёта суммы заказа.
 * Структурно совместим с моделью PriceSettings (id/updatedAt не используются).
 */
export interface PriceList {
  price1: number;
  price2: number;
  price3plus: number;
  depositPerBottle: number;
  pumpPrice: number;
}

@Injectable()
export class PricingService {
  /**
   * Считает итоговую сумму заказа.
   *
   * Первый заказ (SPEC §3.2): bottles × depositPerBottle + pumpPrice (вода бесплатно).
   * Повторный (SPEC §3.1): bottles × цена-за-бутыль по сетке 1 / 2 / 3+.
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
      return bottles * prices.depositPerBottle + prices.pumpPrice;
    }

    let perBottle: number;
    if (bottles === 1) {
      perBottle = prices.price1;
    } else if (bottles === 2) {
      perBottle = prices.price2;
    } else {
      perBottle = prices.price3plus;
    }

    return bottles * perBottle;
  }
}

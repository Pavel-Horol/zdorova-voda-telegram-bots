import { Injectable } from '@nestjs/common';
import type { OrderKind } from '../../../generated/prisma/enums';

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
  electroPumpPrice: number;
  waterStartPrice: number;
}

@Injectable()
export class PricingService {
  /**
   * Считает итоговую сумму заказа по его типу (PRODUCT.md «Расчёт суммы»).
   *
   * - STARTER_KIT — стартовый комплект: bottles × залог + помпа + bottles × старт-вода.
   * - OWN_TARA — своя тара: только вода по сетке (залог 0).
   * - REPEAT — повторный: вода по сетке (добор тары сверх остатка — в T2).
   *
   * @throws Error если bottles не целое положительное число (0 бутылей — не заказ).
   */
  calculateTotal(
    bottles: number,
    kind: OrderKind,
    prices: PriceList,
    bottlesOnHand = 0,
    opts: { electro?: boolean; pumpAddon?: boolean } = {},
  ): number {
    if (!Number.isInteger(bottles) || bottles < 1) {
      throw new Error(`bottles must be a positive integer, got: ${bottles}`);
    }

    switch (kind) {
      case 'STARTER_KIT': {
        // Помпа в комплекте: обычная (250) или электро (270) по выбору клиента.
        const pump = opts.electro ? prices.electroPumpPrice : prices.pumpPrice;
        return (
          bottles * prices.depositPerBottle +
          pump +
          bottles * prices.waterStartPrice
        );
      }
      case 'OWN_TARA':
        // Своя тара: вода по сетке + докупка помпы (250), если у клиента её нет.
        return (
          this.waterByGrid(bottles, prices) +
          (opts.pumpAddon ? prices.pumpPrice : 0)
        );
      case 'REPEAT': {
        // Вода по сетке на ВСЁ количество + залог за каждый новый бак сверх остатка.
        const newTara = this.newTara(bottles, kind, bottlesOnHand);
        return (
          this.waterByGrid(bottles, prices) + newTara * prices.depositPerBottle
        );
      }
      default:
        throw new Error(`unknown order kind: ${String(kind)}`);
    }
  }

  /**
   * Сколько баков заказа — новая тара (под залог): STARTER_KIT — все баки;
   * REPEAT — сверх остатка на руках; OWN_TARA — ноль (тара клиента). Едина для
   * расчёта суммы и для начисления баланса при доставке (PRODUCT.md «добор тары»).
   */
  newTara(bottles: number, kind: OrderKind, bottlesOnHand: number): number {
    switch (kind) {
      case 'STARTER_KIT':
        return bottles;
      case 'REPEAT':
        return Math.max(0, bottles - bottlesOnHand);
      default:
        return 0;
    }
  }

  /** Стоимость воды по сетке города 1 / от 2 / от 6 (PRODUCT.md). */
  private waterByGrid(bottles: number, prices: PriceList): number {
    return bottles * this.waterUnitPrice(bottles, prices);
  }

  /** Цена воды за одну бутыль по сетке для заказа из `bottles` штук. */
  waterUnitPrice(bottles: number, prices: PriceList): number {
    return bottles === 1
      ? prices.price1
      : bottles < 6
        ? prices.priceFrom2
        : prices.priceFrom6;
  }
}

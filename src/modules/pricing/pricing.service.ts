import { Injectable } from '@nestjs/common';
import type { OrderKind } from '../../../generated/prisma/enums';

/**
 * The set of prices needed to calculate the order total.
 * Structurally compatible with the PriceSettings model (id/updatedAt unused).
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
   * Calculates the order total by its kind (PRODUCT.md "Total calculation").
   *
   * - STARTER_KIT — starter kit: bottles × deposit + pump + bottles × starter water.
   * - OWN_TARA — own bottles: water by grid only (deposit 0).
   * - REPEAT — repeat: water by grid (tara top-up above the remainder — in T2).
   *
   * @throws Error if bottles is not a positive integer (0 bottles — not an order).
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
        // Pump in the kit: standard (250) or electric (270) per the client's choice.
        const pump = opts.electro ? prices.electroPumpPrice : prices.pumpPrice;
        return (
          bottles * prices.depositPerBottle +
          pump +
          bottles * prices.waterStartPrice
        );
      }
      case 'OWN_TARA': {
        // Own bottles: water by grid for the whole quantity + deposit for any bottles
        // ordered ABOVE the declared on-hand (tara top-up, same as REPEAT — the client
        // exchanges their own, the extras are new tara under deposit) + optional pump add-on.
        const newTara = this.newTara(bottles, kind, bottlesOnHand);
        return (
          this.waterByGrid(bottles, prices) +
          newTara * prices.depositPerBottle +
          (opts.pumpAddon ? prices.pumpPrice : 0)
        );
      }
      case 'REPEAT': {
        // Water by grid for the WHOLE quantity + deposit per new bottle above the remainder.
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
   * How many bottles of the order are new tara (under deposit): STARTER_KIT — all
   * bottles; REPEAT and OWN_TARA — those ordered above the bottles on hand (for
   * OWN_TARA that is the self-declared `claimedOnHand`). Shared by the total
   * calculation and the balance credit on delivery (PRODUCT.md "tara top-up").
   */
  newTara(bottles: number, kind: OrderKind, bottlesOnHand: number): number {
    switch (kind) {
      case 'STARTER_KIT':
        return bottles;
      case 'REPEAT':
      case 'OWN_TARA':
        return Math.max(0, bottles - bottlesOnHand);
      default:
        return 0;
    }
  }

  /** Water cost by the city grid 1 / from 2 / from 6 (PRODUCT.md). */
  private waterByGrid(bottles: number, prices: PriceList): number {
    return bottles * this.waterUnitPrice(bottles, prices);
  }

  /** Water price per bottle by the grid for an order of `bottles` units. */
  waterUnitPrice(bottles: number, prices: PriceList): number {
    return bottles === 1
      ? prices.price1
      : bottles < 6
        ? prices.priceFrom2
        : prices.priceFrom6;
  }
}

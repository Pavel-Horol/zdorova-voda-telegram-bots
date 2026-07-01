import type { Order, Client, Address } from '../../../generated/prisma/client';
import { driverLine } from './dispatcher-bot.texts';

// Minimal shapes — driverLine only reads the fields below.
function makeOrder(over: Partial<Order> = {}): Order {
  return {
    bottles: 2,
    kind: 'REPEAT',
    newTara: 0,
    electro: false,
    pumpAddon: false,
    totalPrice: 280,
    ...over,
  } as Order;
}
function makeClient(name: string | null = 'Іван'): Client {
  return { name } as Client;
}
function makeAddress(over: Partial<Address> = {}): Address {
  return {
    raw: 'Хмельницького 2 кв5',
    comment: 'домофон 45',
    lat: null,
    lng: null,
    ...over,
  } as Address;
}

describe('driverLine', () => {
  it('repeat water order: "Nпо{unit} = {total}" + address + name', () => {
    const line = driverLine(makeOrder(), makeClient(), makeAddress(), 70);
    expect(line).toBe(
      '2по70 = 280 грн\n📍 Хмельницького 2 кв5 (домофон 45)\n👤 Іван',
    );
  });

  it('own-tara with a tara top-up shows the new-bottle count under deposit', () => {
    const order = makeOrder({
      kind: 'OWN_TARA',
      bottles: 4,
      newTara: 1,
      totalPrice: 730,
    });
    const line = driverLine(
      order,
      makeClient(),
      makeAddress({ comment: null }),
      70,
    );
    expect(line).toBe(
      '4по70 +1 бак = 730 грн\n📍 Хмельницького 2 кв5\n👤 Іван',
    );
  });

  it('own-tara with a pump add-on shows +помпа', () => {
    const order = makeOrder({
      kind: 'OWN_TARA',
      bottles: 2,
      pumpAddon: true,
      totalPrice: 390,
    });
    const line = driverLine(
      order,
      makeClient(),
      makeAddress({ comment: null }),
      70,
    );
    expect(line).toContain('2по70 +помпа = 390 грн');
  });

  it('starter kit: a [ПЕРШИЙ N +помпа] marker instead of per-bottle', () => {
    const order = makeOrder({
      kind: 'STARTER_KIT',
      bottles: 1,
      newTara: 1,
      totalPrice: 750,
    });
    const line = driverLine(
      order,
      makeClient(),
      makeAddress({ comment: null }),
      80,
    );
    expect(line.split('\n')[0]).toBe('[ПЕРШИЙ 1 +помпа] = 750 грн');
  });

  it('starter kit with an electric pump → +електро', () => {
    const order = makeOrder({
      kind: 'STARTER_KIT',
      bottles: 1,
      electro: true,
      totalPrice: 770,
    });
    const line = driverLine(
      order,
      makeClient(),
      makeAddress({ comment: null }),
      80,
    );
    expect(line.split('\n')[0]).toBe('[ПЕРШИЙ 1 +електро] = 770 грн');
  });

  it('appends a maps link when the address is geo-tagged', () => {
    const line = driverLine(
      makeOrder(),
      makeClient(),
      makeAddress({ lat: 49.42, lng: 26.99 }),
      70,
    );
    expect(line).toContain('🗺 https://maps.google.com/?q=49.42,26.99');
  });

  it('falls back to "без імені" when the client has no name', () => {
    const line = driverLine(makeOrder(), makeClient(null), makeAddress(), 70);
    expect(line).toContain('👤 без імені');
  });
});

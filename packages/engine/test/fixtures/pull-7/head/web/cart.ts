export class Cart {
  items: number[] = [];

  total(): number {
    return this.items.reduce((sum, item) => sum + item, 0) * 1.2;
  }
}

export const isEmpty = (cart: Cart): boolean => cart.items.length === 0;

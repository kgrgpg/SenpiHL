import { Decimal } from 'decimal.js';

Decimal.set({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
});

export { Decimal };

export function toDecimal(value: string | number | Decimal): Decimal {
  return new Decimal(value);
}

export function formatDecimal(value: Decimal, decimals = 8): string {
  return value.toFixed(decimals);
}

export function isPositive(value: Decimal): boolean {
  return value.greaterThan(0);
}

export function isNegative(value: Decimal): boolean {
  return value.lessThan(0);
}

export function isZero(value: Decimal): boolean {
  return value.isZero();
}

export function abs(value: Decimal): Decimal {
  return value.abs();
}

export function sum(values: Decimal[]): Decimal {
  return values.reduce((acc, val) => acc.plus(val), new Decimal(0));
}

export function mean(values: Decimal[]): Decimal {
  if (values.length === 0) return new Decimal(0);
  return sum(values).dividedBy(values.length);
}

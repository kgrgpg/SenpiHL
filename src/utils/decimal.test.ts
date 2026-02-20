import { describe, it, expect } from 'vitest';

import {
  Decimal,
  toDecimal,
  formatDecimal,
  isPositive,
  isNegative,
  isZero,
  abs,
  sum,
  mean,
} from './decimal.js';

describe('Decimal Utilities', () => {
  describe('toDecimal', () => {
    it('should convert string to Decimal', () => {
      const result = toDecimal('123.456');
      expect(result.toString()).toBe('123.456');
    });

    it('should convert number to Decimal', () => {
      const result = toDecimal(123.456);
      expect(result.toString()).toBe('123.456');
    });

    it('should pass through existing Decimal', () => {
      const original = new Decimal('123.456');
      const result = toDecimal(original);
      expect(result.toString()).toBe('123.456');
    });

    it('should handle negative values', () => {
      const result = toDecimal('-999.999');
      expect(result.toString()).toBe('-999.999');
    });

    it('should handle zero', () => {
      const result = toDecimal('0');
      expect(result.toString()).toBe('0');
    });

    it('should handle very large numbers', () => {
      const result = toDecimal('999999999999999999.99999999');
      expect(result.toFixed(8)).toBe('999999999999999999.99999999');
    });
  });

  describe('formatDecimal', () => {
    it('should format with default 8 decimals', () => {
      const value = toDecimal('123.456789012345');
      expect(formatDecimal(value)).toBe('123.45678901');
    });

    it('should format with custom decimals', () => {
      const value = toDecimal('123.456789');
      expect(formatDecimal(value, 2)).toBe('123.46');
    });

    it('should pad with zeros', () => {
      const value = toDecimal('100');
      expect(formatDecimal(value, 4)).toBe('100.0000');
    });

    it('should handle negative values', () => {
      const value = toDecimal('-123.456');
      expect(formatDecimal(value, 2)).toBe('-123.46');
    });
  });

  describe('isPositive', () => {
    it('should return true for positive values', () => {
      expect(isPositive(toDecimal('1'))).toBe(true);
      expect(isPositive(toDecimal('0.001'))).toBe(true);
      expect(isPositive(toDecimal('999999'))).toBe(true);
    });

    it('should return false for zero', () => {
      expect(isPositive(toDecimal('0'))).toBe(false);
    });

    it('should return false for negative values', () => {
      expect(isPositive(toDecimal('-1'))).toBe(false);
      expect(isPositive(toDecimal('-0.001'))).toBe(false);
    });
  });

  describe('isNegative', () => {
    it('should return true for negative values', () => {
      expect(isNegative(toDecimal('-1'))).toBe(true);
      expect(isNegative(toDecimal('-0.001'))).toBe(true);
      expect(isNegative(toDecimal('-999999'))).toBe(true);
    });

    it('should return false for zero', () => {
      expect(isNegative(toDecimal('0'))).toBe(false);
    });

    it('should return false for positive values', () => {
      expect(isNegative(toDecimal('1'))).toBe(false);
      expect(isNegative(toDecimal('0.001'))).toBe(false);
    });
  });

  describe('isZero', () => {
    it('should return true for zero', () => {
      expect(isZero(toDecimal('0'))).toBe(true);
      expect(isZero(toDecimal('0.0'))).toBe(true);
      expect(isZero(toDecimal('-0'))).toBe(true);
    });

    it('should return false for non-zero values', () => {
      expect(isZero(toDecimal('1'))).toBe(false);
      expect(isZero(toDecimal('-1'))).toBe(false);
      expect(isZero(toDecimal('0.0001'))).toBe(false);
    });
  });

  describe('abs', () => {
    it('should return absolute value of negative', () => {
      expect(abs(toDecimal('-100')).toString()).toBe('100');
    });

    it('should return same value for positive', () => {
      expect(abs(toDecimal('100')).toString()).toBe('100');
    });

    it('should return zero for zero', () => {
      expect(abs(toDecimal('0')).toString()).toBe('0');
    });
  });

  describe('sum', () => {
    it('should sum array of decimals', () => {
      const values = [toDecimal('10'), toDecimal('20'), toDecimal('30')];
      expect(sum(values).toString()).toBe('60');
    });

    it('should return zero for empty array', () => {
      expect(sum([]).toString()).toBe('0');
    });

    it('should handle negative values', () => {
      const values = [toDecimal('100'), toDecimal('-30'), toDecimal('-20')];
      expect(sum(values).toString()).toBe('50');
    });

    it('should handle mixed positive and negative', () => {
      const values = [toDecimal('100'), toDecimal('-150')];
      expect(sum(values).toString()).toBe('-50');
    });

    it('should maintain precision', () => {
      const values = [toDecimal('0.1'), toDecimal('0.2')];
      expect(sum(values).toString()).toBe('0.3');
    });
  });

  describe('mean', () => {
    it('should calculate mean of decimals', () => {
      const values = [toDecimal('10'), toDecimal('20'), toDecimal('30')];
      expect(mean(values).toString()).toBe('20');
    });

    it('should return zero for empty array', () => {
      expect(mean([]).toString()).toBe('0');
    });

    it('should handle single value', () => {
      const values = [toDecimal('42')];
      expect(mean(values).toString()).toBe('42');
    });

    it('should handle fractional results', () => {
      const values = [toDecimal('1'), toDecimal('2')];
      expect(mean(values).toString()).toBe('1.5');
    });
  });

  describe('Decimal precision', () => {
    it('should handle precise decimal arithmetic', () => {
      const a = toDecimal('0.1');
      const b = toDecimal('0.2');
      const result = a.plus(b);
      expect(result.toString()).toBe('0.3');
    });

    it('should not have floating point errors', () => {
      const a = toDecimal('0.1');
      const b = toDecimal('0.2');
      const c = toDecimal('0.3');
      expect(a.plus(b).equals(c)).toBe(true);
    });
  });
});

import { isNaN, isNil, round } from 'lodash-es';

/** Convert `v` to negative if possitive, don't touch it otherwise. */
export function toNegative(v: number) {
  return v > 0 ? -v : v;
}

/**
 * Converts a float amount to cents. Also takes care of rounding the number
 * to avoid floating numbers issues like `0.29 * 100 === 28.999999999999996`
 */
export function floatAmountToCents(floatAmount: number) {
  return Math.round(floatAmount * 100);
}

export const centsAmountToFloat = (amount: number) => {
  if (isNaN(amount) || isNil(amount)) {
    return null;
  } else {
    return round(amount / 100, 2);
  }
};

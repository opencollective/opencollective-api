import { expect } from 'chai';

import {
  getAmountRangeQuery,
  getAmountRangeValueAndOperator,
} from '../../../../../server/graphql/v2/input/AmountRangeInput';
import { Op } from '../../../../../server/models';

const amount = (valueInCents: number) => ({ valueInCents, currency: 'USD' });

describe('server/graphql/v2/input/AmountRangeInput', () => {
  describe('getAmountRangeQuery', () => {
    it('builds a minimum', () => {
      expect(getAmountRangeQuery({ gte: amount(500) })).to.equal(' >= 500');
    });

    it('builds a maximum', () => {
      expect(getAmountRangeQuery({ lte: amount(500) })).to.equal(' <= 500');
    });

    it('builds a range', () => {
      expect(getAmountRangeQuery({ gte: amount(100), lte: amount(500) })).to.equal(' BETWEEN 100 AND 500');
    });

    it('supports a minimum of zero', () => {
      expect(getAmountRangeQuery({ gte: amount(0) })).to.equal(' >= 0');
    });

    it('supports a maximum of zero', () => {
      expect(getAmountRangeQuery({ lte: amount(0) })).to.equal(' <= 0');
    });

    it('supports a range starting at zero', () => {
      expect(getAmountRangeQuery({ gte: amount(0), lte: amount(500) })).to.equal(' BETWEEN 0 AND 500');
    });
  });

  describe('getAmountRangeValueAndOperator', () => {
    it('keeps a zero minimum', () => {
      expect(getAmountRangeValueAndOperator({ gte: amount(0) })).to.deep.equal({ operator: Op.gte, value: 0 });
    });

    it('returns an undefined value when there is no bound', () => {
      expect(getAmountRangeValueAndOperator({})).to.deep.equal({ operator: Op.lte, value: undefined });
    });
  });
});

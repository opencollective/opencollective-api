import { expect } from 'chai';

import { CurrencyExchangeRate } from '../../../server/models/CurrencyExchangeRate';
import { fakeCurrencyExchangeRate } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/models/CurrencyExchangeRate', () => {
  let rates;

  before(async () => {
    await resetTestDB();
    const today = new Date();
    const oneWeekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    rates = await Promise.all([
      fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR', createdAt: today }),
      fakeCurrencyExchangeRate({ from: 'USD', to: 'NZD', createdAt: today }),
      fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR', createdAt: oneWeekAgo }),
      fakeCurrencyExchangeRate({ from: 'USD', to: 'NZD', createdAt: oneWeekAgo }),
    ]);
  });

  describe('getMany', () => {
    it('returns latest rates for multiple currencies', async () => {
      const result = await CurrencyExchangeRate.getMany('USD', ['EUR', 'NZD']);
      expect(result).to.have.length(2);

      const usdToEur = result.find(rate => rate.to === 'EUR');
      expect(usdToEur).to.exist;
      expect(usdToEur.rate).to.equal(rates[0].rate);

      const usdToNzd = result.find(rate => rate.to === 'NZD');
      expect(usdToNzd).to.exist;
      expect(usdToNzd.rate).to.equal(rates[1].rate);
    });

    it('returns rates from last week for multiple currencies', async () => {
      const twoDaysAgo = new Date(new Date().getTime() - 2 * 24 * 60 * 60 * 1000);
      const result = await CurrencyExchangeRate.getMany('USD', ['EUR', 'NZD'], twoDaysAgo);
      expect(result).to.have.length(2);

      const usdToEur = result.find(rate => rate.to === 'EUR');
      expect(usdToEur).to.exist;
      expect(usdToEur.rate).to.equal(rates[2].rate);

      const usdToNzd = result.find(rate => rate.to === 'NZD');
      expect(usdToNzd).to.exist;
      expect(usdToNzd.rate).to.equal(rates[3].rate);
    });
  });
});

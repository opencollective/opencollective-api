import { expect } from 'chai';
import moment from 'moment';

import CurrencyExchangeRate from '../../../server/models/CurrencyExchangeRate';
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

  describe('getPairStats', () => {
    it('returns up-to-date currency exchange stats', async () => {
      await Promise.all([
        fakeCurrencyExchangeRate({ from: 'USD', to: 'BRL', rate: 5.0, createdAt: moment().subtract(3, 'days') }),
        fakeCurrencyExchangeRate({ from: 'USD', to: 'BRL', rate: 5.1, createdAt: moment().subtract(2, 'days') }),
        fakeCurrencyExchangeRate({ from: 'USD', to: 'BRL', rate: 5.2, createdAt: moment().subtract(1, 'days') }),
        fakeCurrencyExchangeRate({ from: 'USD', to: 'BRL', rate: 5.1, createdAt: moment() }),
      ]);
      const stats = await CurrencyExchangeRate.getPairStats('USD', 'BRL');

      expect(stats).to.have.property('latestRate', 5.1);
      expect(stats).to.have.property('stddev');
      expect(stats).to.have.property('from');
      expect(stats).to.have.property('to');
    });
  });
});

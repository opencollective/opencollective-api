import { expect } from 'chai';
import config from 'config';
import moment from 'moment';
import nock from 'nock';

import * as CurrencyLib from '../../../server/lib/currency.js';
import { fakeCurrencyExchangeRate } from '../../test-helpers/fake-data.js';
import { resetTestDB } from '../../utils.js';

describe('server/lib/currency', () => {
  describe('getRatesFromDb', () => {
    // To remove existing rates
    beforeEach(resetTestDB);

    it('throws if one of the currency is not found', async () => {
      await fakeCurrencyExchangeRate({ from: 'USD', to: 'NGN' });
      await expect(CurrencyLib.getRatesFromDb('USD', ['NGN', 'EUR'])).to.be.rejectedWith(
        'We are not able to fetch the currency FX rates for some currencies at the moment',
      );
    });

    it('returns the latest values available by default', async () => {
      const expectedRates = {
        EUR: await fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR' }),
        NGN: await fakeCurrencyExchangeRate({ from: 'USD', to: 'NGN' }),
      };

      // Create some older rates to try and fool the query
      const yesterday = moment().subtract(1, 'day').toDate();
      await fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR', createdAt: yesterday });
      await fakeCurrencyExchangeRate({ from: 'USD', to: 'NGN', createdAt: yesterday });

      const result = await CurrencyLib.getRatesFromDb('USD', ['NGN', 'EUR']);
      expect(result.NGN).to.eq(expectedRates.NGN.rate);
      expect(result.EUR).to.eq(expectedRates.EUR.rate);
    });

    it('returns the closest values available when a date is provided', async () => {
      const now = moment().toDate();
      const oneMonthAgo = moment().subtract(1, 'month').toDate();
      const twoMonthAgo = moment().subtract(2, 'month').toDate();

      const ratesForNow = {
        EUR: await fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR', createdAt: now }),
        NGN: await fakeCurrencyExchangeRate({ from: 'USD', to: 'NGN', createdAt: now }),
      };

      const ratesFromOneMonthAgo = {
        EUR: await fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR', createdAt: oneMonthAgo }),
        NGN: await fakeCurrencyExchangeRate({ from: 'USD', to: 'NGN', createdAt: oneMonthAgo }),
      };

      // Create some older rates to try and fool the query
      await fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR', createdAt: twoMonthAgo });
      await fakeCurrencyExchangeRate({ from: 'USD', to: 'NGN', createdAt: twoMonthAgo });

      const resultForNow = await CurrencyLib.getRatesFromDb('USD', ['NGN', 'EUR'], now);
      expect(resultForNow.NGN).to.eq(ratesForNow.NGN.rate);
      expect(resultForNow.EUR).to.eq(ratesForNow.EUR.rate);

      const resultFromOneMonthAgo = await CurrencyLib.getRatesFromDb('USD', ['NGN', 'EUR'], oneMonthAgo);
      expect(resultFromOneMonthAgo.NGN).to.eq(ratesFromOneMonthAgo.NGN.rate);
      expect(resultFromOneMonthAgo.EUR).to.eq(ratesFromOneMonthAgo.EUR.rate);
    });

    it('with USD as the target currency', async () => {
      const usdToEurRate = await fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR' });
      const result = await CurrencyLib.getRatesFromDb('EUR', ['USD']);
      expect(result.USD).to.eq(1 / usdToEurRate.rate);
    });

    it('works with other supported currencies', async () => {
      const eurToNzdRate = await fakeCurrencyExchangeRate({ from: 'EUR', to: 'NZD' });
      const result1 = await CurrencyLib.getRatesFromDb('EUR', ['NZD']);
      expect(result1.NZD).to.eq(eurToNzdRate.rate);

      const result2 = await CurrencyLib.getRatesFromDb('NZD', ['EUR']);
      expect(result2.EUR).to.eq(1 / eurToNzdRate.rate);
    });
  });

  describe('convertToCurrency', () => {
    const startDate = '2017-02-01';
    const endDate = '2017-03-01';

    before(() => {
      nock('https://data.fixer.io')
        .get(`/${startDate}`)
        .query({
          access_key: config.fixer.accessKey, // eslint-disable-line camelcase
          base: 'EUR',
          symbols: 'USD',
        })
        .reply(200, { base: 'EUR', date: startDate, rates: { USD: 1.079 } });

      nock('https://data.fixer.io')
        .get(`/${endDate}`)
        .query({
          access_key: config.fixer.accessKey, // eslint-disable-line camelcase
          base: 'EUR',
          symbols: 'USD',
        })
        .reply(200, { base: 'EUR', date: endDate, rates: { USD: 1.0533 } });

      nock('https://data.fixer.io')
        .get(`/${endDate}`)
        .query({
          access_key: config.fixer.accessKey, // eslint-disable-line camelcase
          base: 'INR',
          symbols: 'USD',
        })
        .reply(200, { base: 'INR', date: endDate, rates: { USD: 0.014962 } });
    });

    it('converts EUR to USD', () =>
      CurrencyLib.convertToCurrency(1, 'EUR', 'USD', new Date(startDate)).then(amount =>
        expect(amount).to.equal(1.079),
      ));

    it('converts EUR to USD for another date', () =>
      CurrencyLib.convertToCurrency(1, 'EUR', 'USD', new Date(endDate)).then(amount =>
        expect(amount).to.equal(1.0533),
      ));

    it('converts INR to USD', () =>
      CurrencyLib.convertToCurrency(1, 'INR', 'USD', new Date(endDate)).then(amount =>
        expect(amount).to.equal(0.014962),
      ));
  });
});

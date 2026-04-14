import { expect } from 'chai';
import config from 'config';
import moment from 'moment';
import nock from 'nock';
import sinon from 'sinon';

import * as CurrencyLib from '../../../server/lib/currency';
import { fakeCurrencyExchangeRate } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/lib/currency', () => {
  let sandbox;

  before(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => sandbox.restore());

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

  describe('loadFxRatesMap', () => {
    before(async () => {
      sandbox.stub(config, 'fixer').value({ disableMock: true });

      await resetTestDB();
      // Old rates
      await fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR', createdAt: '2022-01-01T00:00:00.000Z', rate: 0.9 });
      await fakeCurrencyExchangeRate({ from: 'USD', to: 'NZD', createdAt: '2022-01-01T00:00:00.000Z', rate: 1.5 });
      // Latest rates
      await fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR', createdAt: '2023-01-01T00:00:00.000Z', rate: 0.8 });
      await fakeCurrencyExchangeRate({ from: 'USD', to: 'NZD', createdAt: '2023-01-01T00:00:00.000Z', rate: 1.6 });
      await fakeCurrencyExchangeRate({ from: 'EUR', to: 'NZD', createdAt: '2023-01-01T00:00:00.000Z', rate: 1.8 });
    });

    it('returns the rates map for requested conversions', async () => {
      const ratesMap = await CurrencyLib.loadFxRatesMap([
        // Old rates
        { fromCurrency: 'USD', toCurrency: 'EUR', date: '2022-02-01T00:00:00.000Z' },
        { fromCurrency: 'USD', toCurrency: 'NZD', date: '2022-02-01T00:00:00.000Z' },
        // Latest rates
        { fromCurrency: 'USD', toCurrency: 'EUR', date: '2023-02-01T00:00:00.000Z' },
        { fromCurrency: 'USD', toCurrency: 'NZD', date: '2023-02-01T00:00:00.000Z' },
        // No date should return the latest (NOW)
        { fromCurrency: 'USD', toCurrency: 'NZD' },
      ]);

      expect(ratesMap).to.deep.equal({
        '2022-02-01T00:00:00.000Z': { USD: { EUR: 0.9, NZD: 1.5 } }, // Old rates
        '2023-02-01T00:00:00.000Z': { USD: { EUR: 0.8, NZD: 1.6 } }, // Latest rates
        latest: { USD: { NZD: 1.6 } }, // Latest rates (no date provided)
      });
    });
  });

  describe('roundCentsAmount', () => {
    it('leaves amounts unchanged for standard (decimal) currencies', () => {
      expect(CurrencyLib.roundCentsAmount(1234, 'USD')).to.equal(1234);
      expect(CurrencyLib.roundCentsAmount(1650, 'EUR')).to.equal(1650);
      expect(CurrencyLib.roundCentsAmount(99, 'GBP')).to.equal(99);
      expect(CurrencyLib.roundCentsAmount(0, 'USD')).to.equal(0);
    });

    it('rounds to the nearest 100 for zero-decimal currencies', () => {
      // JPY: 1650 → 1700 (rounds up)
      expect(CurrencyLib.roundCentsAmount(1650, 'JPY')).to.equal(1700);
      // JPY: 1049 → 1000 (rounds down)
      expect(CurrencyLib.roundCentsAmount(1049, 'JPY')).to.equal(1000);
      // JPY: 1050 → 1100 (rounds up, half-up behaviour from lodash round)
      expect(CurrencyLib.roundCentsAmount(1050, 'JPY')).to.equal(1100);
      // JPY: already a multiple of 100 – unchanged
      expect(CurrencyLib.roundCentsAmount(1200, 'JPY')).to.equal(1200);
      // KRW behaves the same way
      expect(CurrencyLib.roundCentsAmount(550, 'KRW')).to.equal(600);
    });

    it('rounds to the nearest 100 for all supported zero-decimal currencies', () => {
      const zeroDecimal = [
        'BIF',
        'CLP',
        'DJF',
        'GNF',
        'JPY',
        'KMF',
        'KRW',
        'MGA',
        'PYG',
        'RWF',
        'UGX',
        'VND',
        'VUV',
        'XAF',
        'XOF',
        'XPF',
      ];
      for (const currency of zeroDecimal) {
        expect(CurrencyLib.roundCentsAmount(1650, currency) % 100).to.equal(
          0,
          `${currency} result should be a multiple of 100`,
        );
      }
    });
  });

  describe('floatAmountToCents', () => {
    it('multiplies by 100 and rounds to an integer', () => {
      expect(CurrencyLib.floatAmountToCents(15.5)).to.equal(1550);
      expect(CurrencyLib.floatAmountToCents(12.34)).to.equal(1234);
      expect(CurrencyLib.floatAmountToCents(0)).to.equal(0);
    });

    it('avoids float drift for common decimal values', () => {
      expect(CurrencyLib.floatAmountToCents(0.29)).to.equal(29);
      expect(0.29 * 100).to.not.equal(29);
    });

    it('rounds to the nearest cent', () => {
      expect(CurrencyLib.floatAmountToCents(15.555)).to.equal(1556);
      expect(CurrencyLib.floatAmountToCents(-12.34)).to.equal(-1234);
    });
  });

  describe('centsAmountToFloat', () => {
    it('divides by 100 and rounds to two decimal places', () => {
      expect(CurrencyLib.centsAmountToFloat(1500)).to.equal(15);
      expect(CurrencyLib.centsAmountToFloat(1234)).to.equal(12.34);
      expect(CurrencyLib.centsAmountToFloat(99)).to.equal(0.99);
    });

    it('returns null for null, undefined, or NaN', () => {
      expect(CurrencyLib.centsAmountToFloat(null)).to.equal(null);
      expect(CurrencyLib.centsAmountToFloat(undefined)).to.equal(null);
      expect(CurrencyLib.centsAmountToFloat(NaN)).to.equal(null);
    });
  });

  describe('isZeroDecimalCurrency', () => {
    it('is true for known zero-decimal currencies (case-insensitive)', () => {
      expect(CurrencyLib.isZeroDecimalCurrency('JPY')).to.equal(true);
      expect(CurrencyLib.isZeroDecimalCurrency('jpy')).to.equal(true);
      expect(CurrencyLib.isZeroDecimalCurrency('KRW')).to.equal(true);
    });

    it('is false for standard two-decimal currencies', () => {
      expect(CurrencyLib.isZeroDecimalCurrency('USD')).to.equal(false);
      expect(CurrencyLib.isZeroDecimalCurrency('EUR')).to.equal(false);
    });
  });

  describe('getDefaultCurrencyPrecision', () => {
    it('returns 0 for zero-decimal currencies', () => {
      expect(CurrencyLib.getDefaultCurrencyPrecision('JPY')).to.equal(0);
      expect(CurrencyLib.getDefaultCurrencyPrecision('jpy')).to.equal(0);
    });

    it('returns 2 for other currencies', () => {
      expect(CurrencyLib.getDefaultCurrencyPrecision('USD')).to.equal(2);
      expect(CurrencyLib.getDefaultCurrencyPrecision('eur')).to.equal(2);
    });
  });
});

import { expect } from 'chai';
import nock from 'nock';

import { generateConvertToCurrencyLoader } from '../../../../server/graphql/loaders/currency-exchange-rate';
import { nockFixerRates } from '../../../utils';

const RATES = {
  USD: { EUR: 0.84, NGN: 110.94 },
  EUR: { GBP: 132.45 },
};

describe('server/graphql/loaders/currency-exchange-rate', () => {
  describe('convert', () => {
    before(async () => {
      nockFixerRates(RATES);
    });

    after(() => {
      nock.cleanAll();
    });

    it('Cannot see infos as unauthenticated', async () => {
      const loader = generateConvertToCurrencyLoader();
      const [eurToEur, eurToGbp, usdToEur, usdToNgn] = await loader.loadMany([
        { amount: 100, fromCurrency: 'EUR', toCurrency: 'EUR' },
        { amount: 100, fromCurrency: 'EUR', toCurrency: 'GBP' },
        { amount: 100, fromCurrency: 'USD', toCurrency: 'EUR' },
        { amount: 100, fromCurrency: 'USD', toCurrency: 'NGN' },
      ]);

      expect(eurToEur).to.equal(100);
      expect(eurToGbp).to.equal(Math.round(RATES.EUR.GBP * 100));
      expect(usdToEur).to.equal(Math.round(RATES.USD.EUR * 100));
      expect(usdToNgn).to.equal(Math.round(RATES.USD.NGN * 100));
    });
  });
});

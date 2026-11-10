import { expect } from 'chai';
import config from 'config';
import moment from 'moment';
import { createSandbox } from 'sinon';

import { checkCurrencyExchangeRatesAreNotStale } from '../../../../checks/model/currency-exchange-rates';
import { SUPPORTED_CURRENCIES } from '../../../../server/constants/currencies';
import models from '../../../../server/models';
import { resetTestDB } from '../../../utils';

describe('checks/model/currency-exchange-rates', () => {
  const sandbox = createSandbox();

  beforeEach(resetTestDB);
  afterEach(sandbox.restore);

  const recordRates = (createdAtByCurrency: (currency: string) => Date) =>
    models.CurrencyExchangeRate.bulkCreate(
      SUPPORTED_CURRENCIES.map(currency => ({
        from: currency,
        to: currency === 'USD' ? 'EUR' : 'USD',
        rate: 1.1,
        createdAt: createdAtByCurrency(currency),
      })),
    );

  it('passes when every supported currency was recorded in the last week', async () => {
    sandbox.stub(config, 'env').value('production');
    await recordRates(() => moment().subtract(1, 'day').toDate());
    await checkCurrencyExchangeRatesAreNotStale();
  });

  it('fails on currencies with no rate for more than a week', async () => {
    sandbox.stub(config, 'env').value('production');
    await recordRates(currency =>
      currency === 'NZD' ? moment().subtract(8, 'days').toDate() : moment().subtract(1, 'day').toDate(),
    );
    await models.CurrencyExchangeRate.destroy({ where: { from: 'ZMW' } });

    await expect(checkCurrencyExchangeRatesAreNotStale()).to.be.rejectedWith(
      'No FX rate recorded for more than 7 days: NZD, ZMW',
    );
  });

  it('is skipped outside production and staging', async () => {
    await checkCurrencyExchangeRatesAreNotStale(); // no rates at all in the test DB
  });
});

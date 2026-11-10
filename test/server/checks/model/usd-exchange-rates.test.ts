import { expect } from 'chai';
import config from 'config';
import moment from 'moment';
import { createSandbox } from 'sinon';

import { checkUsdExchangeRatesAreNotStale } from '../../../../checks/model/usd-exchange-rates';
import { SUPPORTED_CURRENCIES } from '../../../../server/constants/currencies';
import models from '../../../../server/models';
import { resetTestDB } from '../../../utils';

describe('checks/model/usd-exchange-rates', () => {
  const sandbox = createSandbox();

  beforeEach(resetTestDB);
  afterEach(sandbox.restore);

  const recordRates = async (createdAtByCurrency: (currency: string) => Date) => {
    for (const currency of SUPPORTED_CURRENCIES) {
      await models.UsdExchangeRate.record({ [currency]: currency === 'USD' ? 1 : 1.1 }, createdAtByCurrency(currency));
    }
  };

  it('passes when every supported currency was recorded in the last week', async () => {
    sandbox.stub(config, 'env').value('production');
    await recordRates(() => moment().subtract(1, 'day').toDate());
    await checkUsdExchangeRatesAreNotStale();
  });

  it('fails on currencies with no rate for more than a week', async () => {
    sandbox.stub(config, 'env').value('production');
    await recordRates(currency =>
      currency === 'NZD' ? moment().subtract(8, 'days').toDate() : moment().subtract(1, 'day').toDate(),
    );
    await models.UsdExchangeRate.destroy({ where: { currency: 'ZMW' } });

    await expect(checkUsdExchangeRatesAreNotStale()).to.be.rejectedWith(
      'No FX rate recorded for more than 7 days: NZD, ZMW',
    );
  });

  it('is skipped outside production and staging', async () => {
    await checkUsdExchangeRatesAreNotStale(); // no rates at all in the test DB
  });
});

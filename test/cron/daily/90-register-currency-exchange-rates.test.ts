import { expect } from 'chai';
import { QueryTypes } from 'sequelize';
import { createSandbox } from 'sinon';

import { run as registerCurrencyExchangeRates } from '../../../cron/daily/90-register-currency-exchange-rates';
import { SUPPORTED_CURRENCIES } from '../../../server/constants/currencies';
import * as currencyLib from '../../../server/lib/currency';
import models, { sequelize } from '../../../server/models';
import * as utils from '../../utils';

describe('cron/daily/register-currency-exchange-rates', () => {
  const sandbox = createSandbox();

  beforeEach(utils.resetTestDB);
  afterEach(sandbox.restore);

  const allRatesFromUsd = () =>
    Object.fromEntries(SUPPORTED_CURRENCIES.map(currency => [currency, currency === 'USD' ? 1 : 2]));

  it('stores the rates from USD only, in one request, and every pair is available', async () => {
    const fetchFxRates = sandbox
      .stub(currencyLib, 'fetchFxRates')
      .resolves({ ...allRatesFromUsd(), EUR: 0.8, NZD: 1.6 });

    await registerCurrencyExchangeRates();

    expect(fetchFxRates.calledOnce).to.be.true;
    expect(fetchFxRates.firstCall.args).to.deep.eq([
      'USD',
      [...SUPPORTED_CURRENCIES],
      'latest',
      { fallbackToDb: false },
    ]);
    const [{ count }] = await sequelize.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "UsdExchangeRates"`,
      { type: QueryTypes.SELECT },
    );
    expect(count).to.eq(SUPPORTED_CURRENCIES.length);

    const [eurToNzd] = await models.UsdExchangeRate.getMany('EUR', ['NZD']);
    expect(eurToNzd.rate).to.be.closeTo(2, 1e-9);
    const [nzdToUsd] = await models.UsdExchangeRate.getMany('NZD', ['USD']);
    expect(nzdToUsd.rate).to.be.closeTo(0.625, 1e-9);
  });

  it('fails without storing anything when no rate is returned', async () => {
    sandbox.stub(currencyLib, 'fetchFxRates').resolves({});
    await expect(registerCurrencyExchangeRates()).to.be.rejectedWith('Could not fetch the exchange rates from USD');
    expect(await models.UsdExchangeRate.count()).to.eq(0);
  });

  it('stores the returned rates, then fails on the missing currencies', async () => {
    const rates = allRatesFromUsd();
    delete rates.NZD;
    sandbox.stub(currencyLib, 'fetchFxRates').resolves(rates);

    await expect(registerCurrencyExchangeRates()).to.be.rejectedWith('No exchange rate returned for: NZD');
    const [eurToUsd] = await models.UsdExchangeRate.getMany('EUR', ['USD']);
    expect(eurToUsd.rate).to.be.closeTo(0.5, 1e-9);
  });
});

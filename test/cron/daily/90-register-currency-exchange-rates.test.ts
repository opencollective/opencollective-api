import { expect } from 'chai';
import { createSandbox } from 'sinon';

import { run as registerCurrencyExchangeRates } from '../../../cron/daily/90-register-currency-exchange-rates';
import { SUPPORTED_CURRENCIES } from '../../../server/constants/currencies';
import * as currencyLib from '../../../server/lib/currency';
import models from '../../../server/models';
import * as utils from '../../utils';

describe('cron/daily/register-currency-exchange-rates', () => {
  const sandbox = createSandbox();

  beforeEach(utils.resetTestDB);
  afterEach(sandbox.restore);

  it('stores the rates of every currency after one that fails, then reports the failure', async () => {
    sandbox.stub(currencyLib, 'fetchFxRates').callsFake(async from => {
      if (from === 'EUR') {
        throw new Error('Fixer rejected the base currency');
      }
      return { USD: 1.5, EUR: 2 };
    });

    await expect(registerCurrencyExchangeRates()).to.be.rejectedWith('Could not store exchange rates for: EUR');

    const storedBases = await models.CurrencyExchangeRate.findAll({ attributes: ['from'], group: ['from'], raw: true });
    const bases = storedBases.map(row => row.from);
    expect(bases).to.have.length(SUPPORTED_CURRENCIES.length - 1);
    expect(bases).to.not.include('EUR');
    expect(bases).to.include('ZMW'); // last of the list, after the failing currency
  });

  it('succeeds when every currency is stored', async () => {
    sandbox.stub(currencyLib, 'fetchFxRates').resolves({ USD: 1.5 });
    await registerCurrencyExchangeRates();
    expect(await models.CurrencyExchangeRate.count()).to.eq(SUPPORTED_CURRENCIES.length);
  });
});

import { expect } from 'chai';

import { checkPayoutMethodsCurrencyMismatch } from '../../../../checks/model/payout-methods';
import models from '../../../../server/models';
import { fakePayoutMethod } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('checks/model/payout-methods: checkPayoutMethodsCurrencyMismatch', () => {
  beforeEach(async () => {
    await resetTestDB();
  });

  it('does not throw when currency column matches data.currency', async () => {
    await fakePayoutMethod({ currency: 'USD', data: { email: 'test@example.com', currency: 'USD' } });

    await expect(checkPayoutMethodsCurrencyMismatch({ fix: false })).to.be.fulfilled;
  });

  it('throws when currency is NULL but data.currency is set', async () => {
    const payoutMethod = await fakePayoutMethod({
      currency: 'USD',
      data: { email: 'test@example.com', currency: 'USD' },
    });
    await models.PayoutMethod.update({ currency: null }, { where: { id: payoutMethod.id }, hooks: false });

    await expect(checkPayoutMethodsCurrencyMismatch({ fix: false })).to.be.rejectedWith(
      /Payout methods with currency mismatch between column and data/,
    );
  });

  it('throws when currency column differs from data.currency', async () => {
    const payoutMethod = await fakePayoutMethod({
      currency: 'USD',
      data: { email: 'test@example.com', currency: 'USD' },
    });
    await models.PayoutMethod.update({ currency: 'EUR' }, { where: { id: payoutMethod.id }, hooks: false });

    await expect(checkPayoutMethodsCurrencyMismatch({ fix: false })).to.be.rejectedWith(
      /Payout methods with currency mismatch between column and data/,
    );
  });

  it('sets currency from data when fix is enabled and currency column is NULL', async () => {
    const payoutMethod = await fakePayoutMethod({
      currency: 'USD',
      data: { email: 'test@example.com', currency: 'USD' },
    });
    await models.PayoutMethod.update({ currency: null }, { where: { id: payoutMethod.id }, hooks: false });

    await checkPayoutMethodsCurrencyMismatch({ fix: true });

    await payoutMethod.reload();
    expect(payoutMethod.currency).to.eq('USD');

    await expect(checkPayoutMethodsCurrencyMismatch({ fix: false })).to.be.fulfilled;
  });

  it('sets currency from data when fix is enabled and currency column conflicts with data.currency', async () => {
    const payoutMethod = await fakePayoutMethod({
      currency: 'USD',
      data: { email: 'test@example.com', currency: 'USD' },
    });
    await models.PayoutMethod.update({ currency: 'EUR' }, { where: { id: payoutMethod.id }, hooks: false });

    await checkPayoutMethodsCurrencyMismatch({ fix: true });

    await payoutMethod.reload();
    expect(payoutMethod.currency).to.eq('USD');

    await expect(checkPayoutMethodsCurrencyMismatch({ fix: false })).to.be.fulfilled;
  });
});

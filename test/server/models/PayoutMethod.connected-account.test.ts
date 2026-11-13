import { expect } from 'chai';

import models, { sequelize } from '../../../server/models';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import { fakeCollective, fakeConnectedAccount, fakePayoutMethod, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('PayoutMethod connected account', () => {
  beforeEach(() => resetTestDB());

  it('creates and removes only the Stripe payout method linked to the connected account', async () => {
    const account = await fakeConnectedAccount({ service: 'stripe', username: 'acct_test' });
    const otherAccount = await fakeConnectedAccount({ service: 'stripe', CollectiveId: account.CollectiveId });
    const payoutMethod = await models.PayoutMethod.findOne({ where: { ConnectedAccountId: account.id } });
    expect(payoutMethod.type).to.equal(PayoutMethodTypes.STRIPE);
    expect(payoutMethod.data).not.to.have.property('connectedAccountId');
    expect(payoutMethod.data).to.have.property('stripeAccountId', 'acct_test');

    await account.destroy();
    expect(await models.PayoutMethod.findByPk(payoutMethod.id)).to.be.null;
    expect(await models.PayoutMethod.findOne({ where: { ConnectedAccountId: otherAccount.id } })).to.exist;
  });

  it('creates Stripe payout methods in the connected account transaction', async () => {
    const collective = await fakeCollective();
    const transaction = await sequelize.transaction();
    try {
      const account = await models.ConnectedAccount.create(
        { service: 'stripe', username: 'acct_transaction', CollectiveId: collective.id },
        { transaction },
      );
      expect(await models.PayoutMethod.findOne({ where: { ConnectedAccountId: account.id }, transaction })).to.exist;
      await account.destroy({ transaction });
      expect(await models.PayoutMethod.findOne({ where: { ConnectedAccountId: account.id }, transaction })).to.be.null;
    } finally {
      await transaction.rollback();
    }
    expect(await models.PayoutMethod.count()).to.equal(0);
  });

  it('ignores connected account links in user-submitted payout methods', async () => {
    const user = await fakeUser();
    const account = await fakeConnectedAccount({ service: 'paypal', CollectiveId: user.CollectiveId });
    const input = {
      type: PayoutMethodTypes.PAYPAL,
      name: 'Manual PayPal',
      currency: 'USD' as const,
      isSaved: true,
      ConnectedAccountId: account.id,
      data: { email: 'manual@paypal.com', currency: 'USD', connectedAccountId: account.id },
    };
    const payoutMethod = await models.PayoutMethod.createFromUserData(input, user, user.collective);
    expect(payoutMethod.ConnectedAccountId).to.be.null;
    expect(payoutMethod.data).not.to.have.property('connectedAccountId');
  });

  it('rejects dangling links and clears the link when the connected account is hard-deleted', async () => {
    await expect(fakePayoutMethod({ ConnectedAccountId: 999999 })).to.be.rejected;
    const account = await fakeConnectedAccount({ service: 'paypal' });
    const payoutMethod = await fakePayoutMethod({ ConnectedAccountId: account.id });
    await account.destroy({ force: true });
    await payoutMethod.reload();
    expect(payoutMethod.ConnectedAccountId).to.be.null;
  });
});

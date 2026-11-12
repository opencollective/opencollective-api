import { expect } from 'chai';
import config from 'config';
import { createSandbox, type SinonStub } from 'sinon';
import type Stripe from 'stripe';

import PlatformConstants from '../../../../server/constants/platform';
import VirtualCardProviders from '../../../../server/constants/virtual-card-providers';
import * as budget from '../../../../server/lib/budget';
import emailLib from '../../../../server/lib/email';
import stripe from '../../../../server/lib/stripe';
import models from '../../../../server/models';
import {
  processAuthorization,
  processCardUpdate,
  processTransaction,
  updateVirtualCardLimit,
} from '../../../../server/paymentProviders/stripe/virtual-cards';
import * as utils from '../../../../server/paymentProviders/utils';
import { fakeCollective, fakeConnectedAccount, fakeUser, fakeVirtualCard } from '../../../test-helpers/fake-data';
import * as testUtils from '../../../utils';

describe('server/paymentProviders/stripe/virtual-cards', () => {
  const sandbox = createSandbox();
  let sendMessage, collectiveAdmin, collective, user, host;

  afterEach(sandbox.restore);
  beforeEach(testUtils.resetTestDB);
  beforeEach(async () => {
    sandbox
      .stub(budget, 'getBalanceAmount')
      .callsFake(() => Promise.resolve({ CollectiveId: 7, currency: 'USD', value: 200 }));
    sandbox.stub(stripe.issuing.authorizations, 'approve').callsFake(() =>
      Promise.resolve({
        approve: true,
      }),
    );

    sendMessage = sandbox.spy(emailLib, 'sendMessage');
    host = await fakeCollective({ id: PlatformConstants.PlatformCollectiveId, hasMoneyManagement: true });
    await fakeConnectedAccount({
      CollectiveId: host.id,
      service: 'stripe',
      token: '33b5e94d-9815-4ebc-b970-3612b6aec332',
      data: {
        stripeEndpointSecret: 'stripeEndpointSecret',
      },
    });
    collectiveAdmin = await fakeUser({ email: 'emailbcc@opencollective.com' });
    collective = await fakeCollective({
      HostCollectiveId: host.id,
      admin: collectiveAdmin.collective,
      name: 'Open Collective',
    });
    user = await fakeUser();
    sandbox.stub(utils, 'getOrCreateVendor').callsFake(() => Promise.resolve({ id: user.id, name: 'stripe' }));
  });

  afterEach(() => sandbox.restore());

  it('sends an email to collective admins about Stripe card purchase', async () => {
    await fakeVirtualCard({
      id: 'card_BM7mGwp1Ea8RtL',
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      provider: VirtualCardProviders.STRIPE,
      UserId: user.id,
    });

    const stripeAuthorization = {
      id: 'stripe_auth_id',
      card: { id: 'card_BM7mGwp1Ea8RtL' },
      /* eslint-disable camelcase */
      pending_request: {
        currency: 'USD',
        amount: 100,
      },
      merchant_data: {
        network_id: '3433223',
        name: 'Public Mobile',
      },
      /* eslint-enable camelcase */
      created: new Date().getTime() / 1000,
    };
    const stripeEvent = {
      data: {
        object: stripeAuthorization,
      },
    } as Stripe.Event;
    const expense = await processAuthorization(stripeEvent);
    await testUtils.waitForCondition(() => sendMessage.callCount === 1);
    const [emailTo, subject, body] = sendMessage.getCall(0).args;
    expect(emailTo).to.equal(collectiveAdmin.email);
    expect(subject).to.equal('Virtual Card Purchase');
    expect(body).to.contain('A card attached to Open Collective was charged $1.00.');
    expect(body).to.contain(`<a href="${config.host.website}/permalink/${expense.publicId}"`);
  });
  describe('zero-decimal currencies (JPY)', () => {
    let jpyCollective, virtualCard;

    const makeAuthorizationEvent = (amount: number) =>
      ({
        data: {
          object: {
            id: `stripe_auth_${amount}`,
            card: { id: 'card_jpy' },
            /* eslint-disable camelcase */
            pending_request: { currency: 'jpy', amount },
            merchant_data: { network_id: '3433223', name: 'Tokyo Store' },
            /* eslint-enable camelcase */
            created: new Date().getTime() / 1000,
          },
        },
      }) as Stripe.Event;

    beforeEach(async () => {
      await host.update({ currency: 'JPY' });
      jpyCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'JPY' });
      virtualCard = await fakeVirtualCard({
        id: 'card_jpy',
        CollectiveId: jpyCollective.id,
        HostCollectiveId: host.id,
        provider: VirtualCardProviders.STRIPE,
        UserId: user.id,
        currency: 'JPY',
      });
      // ¥1,000 balance, stored in cents
      (budget.getBalanceAmount as SinonStub).resolves({
        CollectiveId: jpyCollective.id,
        currency: 'JPY',
        value: 100000,
      });
    });

    it('declines an authorization larger than the balance', async () => {
      const decline = sandbox.stub(stripe.issuing.authorizations, 'decline').resolves();
      // ¥50,000, sent by Stripe as 50000
      await expect(processAuthorization(makeAuthorizationEvent(50000))).to.be.rejectedWith('Balance not sufficient');
      expect(decline.calledOnce).to.be.true;
      expect(stripe.issuing.authorizations.approve as SinonStub).to.not.have.been.called;
      expect(await models.Expense.count({ where: { VirtualCardId: virtualCard.id } })).to.equal(0);
    });

    it('approves an authorization within the balance and records the amount in cents', async () => {
      // ¥500, sent by Stripe as 500
      const expense = await processAuthorization(makeAuthorizationEvent(500));
      expect(stripe.issuing.authorizations.approve as SinonStub).to.have.been.calledOnce;
      expect(expense.currency).to.equal('JPY');
      expect(expense.amount).to.equal(50000);
      const items = await models.ExpenseItem.findAll({ where: { ExpenseId: expense.id } });
      expect(items.map(item => item.amount)).to.deep.equal([50000]);
    });

    it('records settled transactions in cents', async () => {
      const expense = await processTransaction({
        id: 'ipi_jpy',
        card: 'card_jpy',
        amount: -50000, // ¥50,000
        currency: 'jpy',
        type: 'capture',
        authorization: null,
        /* eslint-disable-next-line camelcase */
        merchant_data: { network_id: '3433223', name: 'Tokyo Store' },
        created: Math.floor(Date.now() / 1000),
      } as unknown as Stripe.Issuing.Transaction);

      expect(expense.amount).to.equal(5000000);
      const debit = await models.Transaction.findOne({ where: { ExpenseId: expense.id, type: 'DEBIT' } });
      expect(debit.currency).to.equal('JPY');
      expect(debit.netAmountInCollectiveCurrency).to.equal(-5000000);
    });

    it('sends spending limits to Stripe in JPY units', async () => {
      const update = sandbox.stub(stripe.issuing.cards, 'update').resolves();
      virtualCard.host = host;
      await updateVirtualCardLimit(virtualCard, 1000000); // ¥10,000
      expect(update.firstCall.args[1].spending_controls.spending_limits[0].amount).to.equal(10000);
    });

    it('stores spending limits received from Stripe in cents', async () => {
      await processCardUpdate({
        data: {
          object: {
            id: 'card_jpy',
            currency: 'jpy',
            /* eslint-disable-next-line camelcase */
            spending_controls: { spending_limits: [{ amount: 10000, interval: 'monthly' }] },
          },
        },
      } as unknown as Stripe.Event);
      await virtualCard.reload();
      expect(virtualCard.spendingLimitAmount).to.equal(1000000);
    });
  });
});

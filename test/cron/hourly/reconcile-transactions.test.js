import { expect } from 'chai';
import { createSandbox } from 'sinon';

import { run as reconcileConnectedAccount } from '../../../cron/hourly/reconcile-transactions';
import emailLib from '../../../server/lib/email';
import stripe from '../../../server/lib/stripe';
import { fakeCollective, fakeConnectedAccount, fakeUser, fakeVirtualCard } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('cron/hourly/reconcile-transactions', () => {
  const sandbox = createSandbox();
  let connectedAccount, sendMessage, issuingTransactions, collectiveAdmin;

  afterEach(sandbox.restore);
  beforeEach(utils.resetTestDB);
  beforeEach(async () => {
    issuingTransactions = sandbox.stub(stripe.issuing.transactions, 'list');
    sandbox.stub(stripe.issuing.cards, 'retrieve').callsFake(() =>
      Promise.resolve({
        id: 'card_BM7mGwp1Ea8RtL',
        /* eslint-disable camelcase */
        spending_controls: {
          spending_limits: [{ amount: 0, interval: 'monthly' }],
        },
        /* eslint-enable camelcase */
      }),
    );

    sendMessage = sandbox.spy(emailLib, 'sendMessage');
    const host = await fakeCollective({ isHostAccount: true, slug: 'opencollective' });
    connectedAccount = await fakeConnectedAccount({
      CollectiveId: host.id,
      service: 'stripe',
      token: '33b5e94d-9815-4ebc-b970-3612b6aec332',
    });
    collectiveAdmin = await fakeUser({ email: 'emailbcc@opencollective.com' });
    const collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin.collective });
    const user = await fakeUser();
    await fakeVirtualCard({
      id: 'card_BM7mGwp1Ea8RtL',
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      provider: 'STRIPE',
      UserId: user.id,
    });
  });

  afterEach(() => sandbox.restore());

  it('sends an email to collective admins about Stripe card purchase', async () => {
    issuingTransactions.resolves({
      data: [
        {
          amount: 100,
          card: 'card_BM7mGwp1Ea8RtL',
          created: 1660184523,
          currency: 'CAD',
          /* eslint-disable camelcase */
          merchant_data: {
            category: 'taxicabs_limousines',
            category_code: '4121',
            city: 'Vancouver',
            country: 'CA',
            name: 'Rocket Rides',
            network_id: '1234567890',
            postal_code: '94107',
            state: 'CA',
          },
          /* eslint-enable camelcase */
        },
      ],
    });
    await reconcileConnectedAccount(connectedAccount);
    await utils.waitForCondition(() => sendMessage.callCount === 1);
    const [emailTo, subject] = sendMessage.getCall(0).args;
    expect(emailTo[0]).to.equal(collectiveAdmin.email);
    expect(subject).to.equal('Virtual Card Purchase');
  });
});

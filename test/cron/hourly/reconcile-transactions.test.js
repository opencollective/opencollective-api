import { expect } from 'chai';
import { createSandbox } from 'sinon';

import { run as reconcileTransactions } from '../../../cron/hourly/reconcile-transactions';
import emailLib from '../../../server/lib/email';
import * as privacyLib from '../../../server/lib/privacy';
import stripe from '../../../server/lib/stripe';
import { fakeCollective, fakeConnectedAccount, fakeUser, fakeVirtualCard } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('cron/hourly/reconcile-transactions', () => {
  const sandbox = createSandbox();
  let sendMessage, collectiveAdmin, collective, user, host;

  afterEach(sandbox.restore);
  beforeEach(utils.resetTestDB);
  beforeEach(async () => {
    sandbox.stub(stripe.issuing.transactions, 'list').callsFake(() =>
      Promise.resolve({
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
      }),
    );
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

    sandbox.stub(privacyLib, 'listTransactions').callsFake(() =>
      Promise.resolve({
        /* eslint-disable camelcase */
        data: [
          {
            amount: 100,
            card: {
              created: '2020-07-15T17:48:48Z',
              cvv: '574',
              exp_month: '07',
              exp_year: '2026',
              hostname: '',
              last_four: '6749',
              memo: 'card 2',
              pan: '4111111171826749',
              spend_limit: 0,
              spend_limit_duration: 'TRANSACTION',
              state: 'OPEN',
              token: 'card_PM7mGwp1Ea8RtM',
              type: 'UNLOCKED',
            },
            created: '2020-07-15T19:17:22Z',
            merchant: {
              acceptor_id: '174030075991',
              city: 'NEW YORK',
              country: 'USA',
              descriptor: 'Sample Return',
              mcc: '5812',
              state: 'NY',
            },
            result: 'APPROVED',
            settled_amount: -7666,
            status: 'SETTLING',
            token: '9b4c99b1-2e90-4e24-b54b-90dc8af4695b',
          },
        ],
        /* eslint-enable camelcase */
      }),
    );

    sandbox.stub(privacyLib, 'listCards').callsFake(() =>
      Promise.resolve({
        /* eslint-disable camelcase */
        data: [
          {
            created: '2021-06-28T22:53:15Z',
            cvv: '776',
            funding: {
              account_name: 'string',
              created: '2022-08-11T03:25:59.615Z',
              last_four: 'string',
              nickname: 'string',
              state: 'ENABLED',
              token: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
              type: 'DEPOSITORY_CHECKING',
            },
            exp_month: '06',
            exp_year: '2027',
            hostname: 'string',
            last_four: 'string',
            memo: 'New Card',
            pan: '4111111289144142',
            spend_limit: 1000,
            spend_limit_duration: 'ANNUALLY',
            state: 'CLOSED',
            auth_rule_tokens: ['b68b7424-aa69-4cbc-a946-30d90181b621'],
            token: 'card_PM7mGwp1Ea8RtM',
            type: 'DIGITAL_WALLET',
          },
        ],
        /* eslint-enable camelcase */
      }),
    );

    sendMessage = sandbox.spy(emailLib, 'sendMessage');
    host = await fakeCollective({ isHostAccount: true, slug: 'opencollective' });
    await fakeConnectedAccount({
      CollectiveId: host.id,
      service: 'stripe',
      token: '33b5e94d-9815-4ebc-b970-3612b6aec332',
    });
    await fakeConnectedAccount({
      CollectiveId: host.id,
      service: 'privacy',
      token: '33b5e94d-9815-4ebc-b970-3612b6aec333',
    });
    collectiveAdmin = await fakeUser({ email: 'emailbcc@opencollective.com' });
    collective = await fakeCollective({
      HostCollectiveId: host.id,
      admin: collectiveAdmin.collective,
      name: 'Open Collective',
    });
    user = await fakeUser();
  });

  afterEach(() => sandbox.restore());

  it('sends an email to collective admins about Stripe card purchase', async () => {
    await fakeVirtualCard({
      id: 'card_BM7mGwp1Ea8RtL',
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      provider: 'STRIPE',
      UserId: user.id,
    });
    await reconcileTransactions();
    await utils.waitForCondition(() => sendMessage.callCount === 1);
    const [emailTo, subject, body] = sendMessage.getCall(0).args;
    expect(emailTo[0]).to.equal(collectiveAdmin.email);
    expect(subject).to.equal('Virtual Card Purchase');
    expect(body).to.contain('A card attached to Open Collective was charged CA$1.00.');
  });

  it('sends an email to collective admins about Privacy card purchase', async () => {
    await fakeVirtualCard({
      id: 'card_PM7mGwp1Ea8RtM',
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      provider: 'PRIVACY',
      UserId: user.id,
    });
    await reconcileTransactions();
    await utils.waitForCondition(() => sendMessage.callCount === 1);
    const [emailTo, subject, body] = sendMessage.getCall(0).args;
    expect(emailTo[0]).to.equal(collectiveAdmin.email);
    expect(subject).to.equal('Virtual Card Purchase');
    expect(body).to.contain('A card attached to Open Collective was charged $1.00.');
  });
});

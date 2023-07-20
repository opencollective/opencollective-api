import { expect } from 'chai';
import config from 'config';
import { createSandbox } from 'sinon';

import * as budget from '../../../../server/lib/budget.js';
import emailLib from '../../../../server/lib/email.js';
import stripe from '../../../../server/lib/stripe.js';
import { processAuthorization } from '../../../../server/paymentProviders/stripe/virtual-cards.js';
import * as utils from '../../../../server/paymentProviders/utils.js';
import { fakeCollective, fakeConnectedAccount, fakeUser, fakeVirtualCard } from '../../../test-helpers/fake-data.js';
import * as testUtils from '../../../utils.js';

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
    host = await fakeCollective({ isHostAccount: true, slug: 'opencollective' });
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
      provider: 'STRIPE',
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
    };
    const expense = await processAuthorization(stripeEvent);
    await testUtils.waitForCondition(() => sendMessage.callCount === 1);
    const [emailTo, subject, body] = sendMessage.getCall(0).args;
    expect(emailTo).to.equal(collectiveAdmin.email);
    expect(subject).to.equal('Virtual Card Purchase');
    expect(body).to.contain('A card attached to Open Collective was charged $1.00.');
    expect(body).to.contain(`<a href="${config.host.website}/${collective.slug}/expenses/${expense.id}?edit=1"`);
  });
});

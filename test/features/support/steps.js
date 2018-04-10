/* Test tools */
import sinon from 'sinon';
import Promise from 'bluebird';

import { After, Before, Given, When, Then } from 'cucumber';
import { expect } from 'chai';
import { resetTestDB } from '../../utils';

/* Required for building context  */
import models from '../../../server/models';
import * as stripe from '../../../server/paymentProviders/stripe/gateway';

/* What's being tested */
import * as libledger from '../../../server/lib/ledger';
import * as libpayments from '../../../server/lib/payments';

/* Sandbox for mocks, stubs, etc.*/
const sandbox = sinon.sandbox.create();

/* Setup environment for each test.
 *
 * Two main things are needed here: 1. mock stripe calls; 2. clean
 * database */
Before(async () => {
  sandbox.stub(stripe, "createCustomer", async () => Promise.resolve({ id: "cus_BM7mGwp1Ea8RtL"}));
  sandbox.stub(stripe, "createToken", async () => Promise.resolve({ id: "tok_1AzPXGD8MNtzsDcgwaltZuvp"}));
  sandbox.stub(stripe, "createCharge", async () => Promise.resolve({ id: "ch_1AzPXHD8MNtzsDcgXpUhv4pm"}));
  await resetTestDB();
});

After(() => sandbox.restore());

Given('a Collective with a host in {string}', async function (currency) {
  const hostOwner = await models.User.create({ email: 'a@host.co' });
  const host = await models.Collective.create({
    CreatedByUserId: hostOwner.id,
    slug: "Host",
    currency,
  });
  const collective = await models.Collective.create({ name: "Parcel" });
  await collective.addHost(host);
  await models.ConnectedAccount.create({
    service: 'stripe',
    token: 'sk_test_XOFJ9lGbErcK5akcfdYM1D7j',
    username: 'acct_198T7jD8MNtzsDcg',
    CollectiveId: host.id,
  });
  this.transaction.set({ hostOwner, host, collective });
});

Given('the conversion rate from {string} to {string} is {float}', function (from, to, rate) {
  this.transaction.set({ fx: { from, to, rate }});
});

Given(/^(\w+) Fee is "(\d+)%" of the order$/, async function (name, value) {
  this.transaction.set({ fee: { name, value }});
});

When('a User donates {string} to Collective', async function (amount) {
  const [value, currency] = amount.split(' ');
  const user = await models.User.createUserWithCollective({
    username: 'username',
    email: 'username@host.com',
  });
  const order = await models.Order.create({
    description: 'Donation',
    totalAmount: parseInt(value),
    currency,
    CreatedByUserId: user.id,
    FromCollectiveId: user.CollectiveId,
    CollectiveId: this.transaction.state.collective.id,
  });
  await order.setPaymentMethod({
    token: "tok_123456781234567812345678",
  });
  this.transaction.set({ user, order });

  sandbox.stub(
    stripe,
    "retrieveBalanceTransaction",
    this.transaction.createRetrieveBalanceTransactionStub(value, currency));

  const transaction = await libpayments.executeOrder(user, order);
  this.transaction.set({ transaction });
});

Then('the {string} should have {string} in balance', function(ledger, amount) {
  const [value, currency] = amount.split(' ');
  const ledgerId = {
    Collective: this.transaction.state.collective.id,
    User: this.transaction.state.user.CollectiveId,
  }[ledger];

  console.log(value, currency, ledgerId);

  //expect(this.variable).to.eql(number);
});

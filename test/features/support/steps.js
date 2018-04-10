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

export function randEmail(email) {
  const [user, domain] = email.split('@');
  const rand = Math.random().toString(36).substring(2, 15);
  return `${user}-${rand}@${domain}`;
}


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

Given('a User {string}', async function (name) {
  const email = randEmail(`${name}@oc.com`);
  const user = await models.User.createUserWithCollective({
    email,
    name,
    username: name,
    description: `A user called ${name}`,
  });
  this.transaction.keys[name] = user.collective;
});

Given(/^a Collective "([^\"]+)" with a host in "([^\"]+)"( and "([^\"]+)%" fee)?$/, async function (name, currency, fee) {
  const email = randEmail(`${name}-host-${currency}@oc.com`);
  const hostOwner = await models.User.create({ email });
  const host = await models.Collective.create({
    CreatedByUserId: hostOwner.id,
    slug: "Host",
    hostFeePercent: fee ? parseInt(fee) : 0,
    currency,
  });

  const collective = await models.Collective.create({ name });
  await collective.addHost(host);
  await models.ConnectedAccount.create({
    service: 'stripe',
    token: 'sk_test_XOFJ9lGbErcK5akcfdYM1D7j',
    username: 'acct_198T7jD8MNtzsDcg',
    CollectiveId: host.id,
  });

  this.transaction.keys[name] = collective;
  this.transaction.keys[`${name}-host`] = host;
  this.transaction.set({ hostOwner, host, collective });
});

Given('the conversion rate from {string} to {string} is {float}', function (from, to, rate) {
  this.transaction.set({ fx: { from, to, rate }});
});

Given(/^(\w+) fee is "(\d+)%" of the order$/, async function (name, value) {
  this.transaction.set({ fee: { name, value }});
});

When('{string} donates {string} to {string}', async function (from, amount, to) {
  const [value, currency] = amount.split(' ');
  const fromNode = this.transaction.keys[from];
  const toNode = this.transaction.keys[to];
  const order = await models.Order.create({
    description: 'Donation',
    totalAmount: parseInt(value),
    currency,
    CreatedByUserId: fromNode.CreatedByUserId,
    FromCollectiveId: fromNode.id,
    CollectiveId: toNode.id,
  });
  await order.setPaymentMethod({
    token: "tok_123456781234567812345678",
  });

  sandbox.stub(
    stripe,
    "retrieveBalanceTransaction",
    this.transaction.createRetrieveBalanceTransactionStub(value, currency));

  const user = models.User.findById(fromNode.CreatedByUserId);

  const transaction = await libpayments.executeOrder(user, order);

  this.transaction.set({ order, transaction });
});

Then('{string} should have {string} in their balance', function(ledger, amount) {
  const ledgerId = this.transaction.keys[ledger].id;
  const [value, currency] = amount.split(' ');
  console.log(value, currency, ledgerId);

  //expect(this.variable).to.eql(number);
});

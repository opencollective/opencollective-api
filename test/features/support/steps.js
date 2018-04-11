import Promise from 'bluebird';

/* Test tools */
import sinon from 'sinon';
import { After, Before, Given, When, Then } from 'cucumber';
import { expect } from 'chai';
import { resetTestDB } from '../../utils';
import * as libteststore from '../../lib/stores';

/* Required for building context  */
import * as stripe from '../../../server/paymentProviders/stripe/gateway';
import models from '../../../server/models';

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

/* Reset the mocks after each run */
After(() => sandbox.restore());

Given('a User {string}', async function (name) {
  const { userCollective } = await libteststore.newUser(name);
  this.transaction.keys[name] = userCollective;
});

Given(/^a Collective "([^\"]+)" with a host in "([^\"]+)"( and "([^\"]+)%" fee)?$/, async function (name, currency, fee) {
  const { host, collective } = await libteststore.collectiveWithHost(name, currency, fee);
  this.transaction.keys[name] = collective;
  this.transaction.keys[`${name}-host`] = host;
  this.transaction.set({ host, collective });
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
  const { order } = await libteststore.orderAndPaymentMethod(
    fromNode, toNode, parseInt(value), currency);

  /* This has to be called before executeOrder() and it's being called
   * here and not in the hook because it needs the order parameters to
   * be generated. */
  sandbox.stub(
    stripe,
    "retrieveBalanceTransaction",
    this.transaction.createRetrieveBalanceTransactionStub(value, currency));

  const user = await models.User.findById(fromNode.CreatedByUserId);
  const transaction = await libpayments.executeOrder(user, order);
  this.transaction.set({ order, transaction });
});

Then('{string} should have {string} in their balance', function(ledger, amount) {
  const ledgerId = this.transaction.keys[ledger].id;
  const rows = libledger.rows(this.transaction.state.transaction.TransactionGroup);
  const balance = libledger.balanceFromCurrency(ledgerId, rows);
  // expect(balance).to.equal(amount);
});

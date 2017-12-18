import { expect } from 'chai';
import { describe, it } from 'mocha';
import models from '../server/models';
import * as utils from './utils';
import Stripe from 'stripe';
import config from 'config';
import nock from 'nock';
// import initNock from './graphql.createOrder.nock';

const createOrderQuery = `
  mutation createOrder($order: OrderInputType!) {
    createOrder(order: $order) {
      id
      createdByUser {
        id
      }
      paymentMethod {
        id
      }
      totalAmount
      fromCollective {
        id
        slug
        name
        website
      }
      collective {
        id
        slug
        currency
      }
      subscription {
        id
        amount
        interval
        isActive
        stripeSubscriptionId
      }
      processedAt
    }
  }
`;

describe('graphql.createOrder.btc.test.js', () => {
  
  let collective, host, admin, hostStripeAccount;
  // before(initNock);

  // after(() => {
  //   nock.cleanAll();
  // });

  beforeEach(() => utils.resetTestDB());
  beforeEach(async () => {
    admin = await models.User.createUserWithCollective({ name: "admin" });
    host = await models.Collective.create({ type: "ORGANIZATION", name: "host", isActive: true});
    collective = await models.Collective.create({ name: "tipbox", slug: "tipbox", hostFeePercent: 5, isActive: true, HostCollectiveId: host.id });
    hostStripeAccount = await models.ConnectedAccount.create({
      CreatedByUserId: admin.id,      
      service: 'stripe',
      username: 'acct_18KWlTLzdXg9xKNS', // using opensource host test stripe account
      token: 'sk_test_iDWQubtz4ixk0FQg1csgCi6p',
      data: {
        publishableKey: 'pk_test_l7H1cDlh2AekeETfq742VJbC'
      },
      CollectiveId: host.id
    });
    await models.Member.create({
      CreatedByUserId: admin.id,
      CollectiveId: collective.id,
      MemberCollectiveId: host.id,
      role: 'HOST'
    });
  });

  it('creates an order as new user', async () => {

    const stripe = Stripe(config.stripe.secret);

    const order = {
      "user": {
        "email": "fdsf@fsds.com",
        "firstName": "First name",
        "lastName": "Last name",
        "company": "company"
      },
      "fromCollective": {
        "name": "new org"
      },
      "quantity": 1,
      "interval": null,
      "totalAmount": 5000,
      "paymentMethod": {
        "service": "stripe",
        "type": "bitcoin",
        "currency": "BTC"
      },
      "collective": {
        "id": collective.id
      }
    };

    const source = await stripe.sources.create({
      type: 'bitcoin',
      amount: order.totalAmount,
      currency: 'usd',
      metadata: {
        CollectiveId: collective.id
      },
      owner: {
        email: order.user.email,
        name: order.user.name
      }      
    });

    order.paymentMethod.token = source.id;

    const res = await utils.graphqlQuery(createOrderQuery, { order });
    res.errors && console.error(res.errors);
    expect(res.errors).to.not.exist;
    const fromCollective = res.data.createOrder.fromCollective;
    const transaction = await models.Transaction.findOne({
      where: { CollectiveId: collective.id, amount: order.totalAmount }
    });
    expect(transaction.FromCollectiveId).to.equal(fromCollective.id);
    expect(transaction.CollectiveId).to.equal(collective.id);
    expect(transaction.currency).to.equal(collective.currency);
    expect(transaction.hostFeeInHostCurrency).to.equal(0.05 * order.totalAmount);
    expect(transaction.platformFeeInHostCurrency).to.equal(0.05 * order.totalAmount);

    expect(transaction.data.charge.currency).to.equal(collective.currency.toLowerCase());
    expect(transaction.data.charge.status).to.equal('succeeded');
    expect(transaction.data.balanceTransaction.net - transaction.hostFeeInHostCurrency).to.equal(transaction.netAmountInCollectiveCurrency);

    // we create a customer on the host stripe account even for one time charges
    expect(transaction.data.charge.customer).to.not.be.null;

    // make sure the payment has been recorded in the connected Stripe Account of the host
    const hostMember = await models.Member.findOne({ where: { CollectiveId: collective.id, role: 'HOST' } });
    const hostStripeAccount = await models.ConnectedAccount.findOne({
      where: { service: 'stripe', CollectiveId: hostMember.MemberCollectiveId }
    });
    const charge = await Stripe(hostStripeAccount.token).charges.retrieve(transaction.data.charge.id);
    expect(charge.source.last4).to.equal('4242');
  });

});

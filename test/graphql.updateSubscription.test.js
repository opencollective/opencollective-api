import sinon from 'sinon';
import nodemailer from 'nodemailer';
import { expect } from 'chai';
import config from 'config';

import * as utils from '../test/utils';
import models from '../server/models';
import initNock from './graphql.updateSubscription.nock';

const ordersData = utils.data('orders');

const updateSubscriptionQuery = `
mutation updateSubscription($id: Int!, $paymentMethod: PaymentMethodInputType, $amount: Int) {
  updateSubscription(id: $id, paymentMethod: $paymentMethod, amount: $amount) {
    id
    currency
    totalAmount
    interval
    createdAt
    isSubscriptionActive
    collective {
      id
    }
    fromCollective {
      id
      slug
      createdByUser {
        id
      }
    }
    paymentMethod {
      id
      uuid
      data
      name
      expiryDate
    }
  }
}
`;

describe('graphql.updateSubscriptions.test.js', () => {
  let collective, user, user2, paymentMethod, sandbox;

  before(initNock);

  before(() => {
    sandbox = sinon.sandbox.create();
  });

  after(() => sandbox.restore());

  beforeEach(() => utils.resetTestDB());

  beforeEach(() => models.User.createUserWithCollective(utils.data('user1')).tap((u => user = u)));

  beforeEach(() => models.User.createUserWithCollective(utils.data('user2'))
    .tap((u => user2 = u)));

  beforeEach(() => models.Collective.create(utils.data('collective1')).tap((g => collective = g)));

  beforeEach(() => collective.addHost(user.collective));

  // create stripe account
  beforeEach(() => {
    models.ConnectedAccount.create({
      service: 'stripe',
      token: 'sktest_123',
      CollectiveId: user.CollectiveId
    })
  });

  // Create a paymentMethod.
  beforeEach(() => models.PaymentMethod.create(utils.data('paymentMethod2')).tap(c => paymentMethod = c));

  afterEach(() => {
    utils.clearbitStubAfterEach(sandbox);
  });

  /**
   * Update subscription
   */
  describe('#update', () => {

    const subscription = utils.data('subscription1');
    let order, nm;

    // create a fake nodemailer transport
    beforeEach(() => {
      config.mailgun.user = 'xxxxx';
      config.mailgun.password = 'password';

      nm = nodemailer.createTransport({
            name: 'testsend',
            service: 'Mailgun',
            sendMail (data, callback) {
                callback();
            },
            logger: false
          });
      sinon.stub(nodemailer, 'createTransport', () => nm);
    });

    // stub the transport
    beforeEach(() => sinon.stub(nm, 'sendMail', (object, cb) => cb(null, object)));

    afterEach(() => nm.sendMail.restore());

    afterEach(() => {
      config.mailgun.user = '';
      config.mailgun.password = '';
      nodemailer.createTransport.restore();
    });

    beforeEach(() => {
      return models.Subscription.create(subscription)
        .then(sub => models.Order.create({
          ...ordersData[0],
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          PaymentMethodId: paymentMethod.id,
          SubscriptionId: sub.id
        }))
        .tap(d => order = d)
        .catch()
    });

    it('fails if if no authorization provided', async () => {
      const res = await utils.graphqlQuery(updateSubscriptionQuery, { id: order.id, paymentMethod: {}});

      expect(res.errors).to.exist;
      expect(res.errors[0].message).to.equal('You need to be logged in to update a subscription');
    });

    it('fails if the subscription does not exist', async () => {
      const res = await utils.graphqlQuery(updateSubscriptionQuery, { id: 2}, user);
      expect(res.errors).to.exist;
      expect(res.errors[0].message).to.equal('Subscription not found');
    });

    it('fails if user isn\'t an admin of the collective' , async () => {
      const res = await utils.graphqlQuery(updateSubscriptionQuery, { id: order.id}, user2);

      expect(res.errors).to.exist;
      expect(res.errors[0].message).to.equal('You don\'t have permission to update this subscription');
    });

    it('fails if the subscription is not active', async () => {
      const order2 = await models.Subscription.create(Object.assign({}, subscription, {isActive: false, deactivatedAt: new Date()}))
        .then(sub => models.Order.create({
          ...ordersData[0],
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          PaymentMethodId: paymentMethod.id,
          SubscriptionId: sub.id
        }))

      const res = await utils.graphqlQuery(updateSubscriptionQuery, { id: order2.id}, user);

      expect(res.errors).to.exist;
      expect(res.errors[0].message).to.equal('Subscription must be active to be updated')
    })

    describe('updating payment method', async () => {

      it('fails if the payment method uuid doesn\'t exist', async () => {
        const res = await utils.graphqlQuery(updateSubscriptionQuery, {id:order.id, paymentMethod: { uuid: 'c7279ed2-e825-4494-98b8-12ad1a3b85ff'}}, user);

        expect(res.errors).to.exist;
        expect(res.errors[0].message).to.equal('Payment method not found with this uuid')
      });

      it('succeeds when the payment method uuid is valid', async () => {
        const pm2 = await models.PaymentMethod.create(Object.assign({}, utils.data('paymentMethod2'), {token: 'tok_123456781234567812345612', customerId: 'cus_new', name: '3434'}));

        const res = await utils.graphqlQuery(updateSubscriptionQuery, {id:order.id, paymentMethod: { uuid: pm2.uuid }}, user);

        expect(res.errors).to.not.exist;

        const updatedOrder = await models.Order.findById(order.id);

        expect(updatedOrder.PaymentMethodId).to.equal(pm2.id);
      });

      it('succeeds in updating subscription to a new payment method', async () => {

        const res = await utils.graphqlQuery(updateSubscriptionQuery, {
          id:order.id, 
          paymentMethod: {
             name: '8431',
             token: 'tok_1BvCA5DjPFcHOcTmg1234567',
             service: 'stripe',
             type: 'creditcard',
             data: { 
              expMonth: 1,
              expYear: 2019,
              brand: 'American Express',
              country: 'US',
              funding: 'credit',
              zip: '10012' 
            } 
          }
        }, user);

        expect(res.errors).to.not.exist;

        const newPM = await models.PaymentMethod.findOne({
          where: {
            name: '8431',
            token: 'tok_1BvCA5DjPFcHOcTmg1234567'
          }
        });

        const updatedOrder = await models.Order.findById(order.id);

        expect(updatedOrder.PaymentMethodId).to.equal(newPM.id);

      });

    })


  });
});

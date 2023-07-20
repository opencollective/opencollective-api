import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';

import * as payments from '../../../../server/lib/payments.js';
import models from '../../../../server/models/index.js';
import * as store from '../../../stores/index.js';
import * as utils from '../../../utils.js';

describe('server/graphql/v1/user', () => {
  let user1, user2, host, collective1, collective2, tier1, ticket1, sandbox;

  before(() => (sandbox = createSandbox()));

  before(() => {
    sandbox.stub(payments, 'executeOrder').callsFake((user, order) => {
      return models.Order.update({ processedAt: new Date() }, { where: { id: order.id } });
    });
  });

  after(() => sandbox.restore());

  beforeEach(() => utils.resetTestDB());

  beforeEach(async () => {
    user1 = await models.User.createUserWithCollective(utils.data('user1'));
  });
  beforeEach(async () => {
    user2 = await models.User.createUserWithCollective(utils.data('user2'));
  });
  beforeEach(async () => {
    host = await models.User.createUserWithCollective(utils.data('host1'));
  });

  beforeEach(async () => {
    collective1 = await models.Collective.create(utils.data('collective1'));
  });

  beforeEach(async () => {
    collective2 = await models.Collective.create(utils.data('collective2'));
  });

  beforeEach(async () => {
    tier1 = await collective1.createTier(utils.data('tier1'));
  });
  beforeEach(async () => {
    ticket1 = await collective1.createTier(utils.data('ticket1'));
  });

  beforeEach(() => collective1.addUserWithRole(user1, 'BACKER'));
  beforeEach(() => collective2.addUserWithRole(user1, 'ADMIN'));
  beforeEach(() => collective1.addHost(host.collective, host));

  beforeEach('create stripe account', () =>
    models.ConnectedAccount.create({
      service: 'stripe',
      token: 'abc',
      CollectiveId: host.id,
    }),
  );

  describe('graphql.user.test.js', () => {
    describe('logged in user', () => {
      const loggedInUserQuery = gql`
        query LoggedInUser {
          LoggedInUser {
            id
            memberOf {
              collective {
                slug
              }
              role
            }
          }
        }
      `;

      it('returns all collectives with role', async () => {
        const result = await utils.graphqlQuery(loggedInUserQuery, null, user1);
        result.errors && console.error(result.errors);
        const data = result.data.LoggedInUser;
        expect(data.memberOf.length).to.equal(2);
        expect(data.memberOf[0].role).to.equal('BACKER');
        expect(data.memberOf[1].role).to.equal('ADMIN');
      });

      it("doesn't return anything if not logged in", async () => {
        const result = await utils.graphqlQuery(loggedInUserQuery);
        result.errors && console.error(result.errors);
        const data = result.data.LoggedInUser;
        expect(data).to.be.null;
      });
    });

    describe('payment methods', () => {
      const generateLoggedInOrder = (tier = tier1) => {
        return {
          description: 'test order',
          paymentMethod: {
            service: 'stripe',
            name: '4242',
            token: 'tok_123456781234567812345678',
            save: true,
            data: {
              expMonth: 1,
              expYear: 2021,
              funding: 'credit',
              brand: 'Visa',
              country: 'US',
            },
          },
          collective: { id: collective1.id },
          tier: { id: tier.id },
        };
      };

      const generateLoggedOutOrder = (tier = tier1) => {
        return {
          ...generateLoggedInOrder(tier),
        };
      };

      it('saves a payment method to the user', async () => {
        const createOrderMutation = gql`
          mutation CreateOrder($order: OrderInputType!) {
            createOrder(order: $order) {
              paymentMethod {
                name
              }
              fromCollective {
                id
              }
              createdByUser {
                id
                email
              }
            }
          }
        `;

        const result = await utils.graphqlQuery(createOrderMutation, { order: generateLoggedInOrder() }, user1);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        const paymentMethods = await models.PaymentMethod.findAll({
          where: { CreatedByUserId: user1.id },
        });
        paymentMethods.errors && console.error(paymentMethods.errors);
        expect(paymentMethods).to.have.length(1);
        expect(paymentMethods[0].name).to.equal('4242');
        expect(paymentMethods[0].CollectiveId).to.equal(result.data.createOrder.fromCollective.id);
      });

      it('does not save a payment method to the user', async () => {
        const order = generateLoggedInOrder();
        order.paymentMethod.save = false;
        const createOrderMutation = gql`
          mutation CreateOrder($order: OrderInputType!) {
            createOrder(order: $order) {
              createdByUser {
                id
                email
              }
              paymentMethod {
                name
              }
            }
          }
        `;

        const result = await utils.graphqlQuery(createOrderMutation, { order }, user1);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        const paymentMethods = await models.PaymentMethod.findAll({
          where: { CreatedByUserId: user1.id },
        });
        expect(paymentMethods).to.have.length(1);
        expect(paymentMethods[0].CollectiveId).to.be.eq(user1.CollectiveId);
        expect(paymentMethods[0].saved).to.be.null;
      });

      it("doesn't get the payment method of the user if not logged in", async () => {
        const createOrderMutation = gql`
          mutation CreateOrder($order: OrderInputType!) {
            createOrder(order: $order) {
              description
            }
          }
        `;

        const remoteUser = await models.User.createUserWithCollective({
          email: store.randEmail('user@opencollective.com'),
        });
        await utils.graphqlQuery(
          createOrderMutation,
          {
            order: generateLoggedOutOrder(ticket1),
          },
          remoteUser,
        );

        const tierQuery = gql`
          query Tier($id: Int!) {
            Tier(id: $id) {
              id
              name
              orders {
                id
                description
                createdByUser {
                  id
                }
                paymentMethod {
                  name
                }
              }
            }
          }
        `;
        const result = await utils.graphqlQuery(tierQuery, { id: ticket1.id });
        result.errors && console.error(result.errors);
        const orders = result.data.Tier.orders;
        expect(orders).to.have.length(1);
        expect(orders[0].paymentMethod).to.be.null;
        const result2 = await utils.graphqlQuery(tierQuery, { id: ticket1.id }, user2);
        result2.errors && console.error(result2.errors);
        const orders2 = result2.data.Tier.orders;
        expect(orders2).to.have.length(1);
        expect(orders2[0].paymentMethod).to.be.null;
      });

      it('gets the payment method of the user if logged in as that user', async () => {
        const order = generateLoggedInOrder();
        const createOrderMutation = gql`
          mutation CreateOrder($order: OrderInputType!) {
            createOrder(order: $order) {
              description
            }
          }
        `;

        await utils.graphqlQuery(createOrderMutation, { order }, user1);
        await models.PaymentMethod.update({ confirmedAt: new Date() }, { where: { CreatedByUserId: user1.id } });

        const tierQuery = gql`
          query Tier($id: Int!) {
            Tier(id: $id) {
              name
              orders {
                id
                description
                createdByUser {
                  id
                }
                paymentMethod {
                  name
                }
              }
            }
          }
        `;
        const result = await utils.graphqlQuery(tierQuery, { id: tier1.id }, user1);
        result.errors && console.error(result.errors);
        const orders = result.data.Tier.orders;
        expect(orders).to.have.length(1);
        expect(orders[0].paymentMethod.name).to.equal('4242');
      });
    });
  });
});

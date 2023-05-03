import { expect } from 'chai';
import gql from 'fake-tag';
import { graphql } from 'graphql';
import { describe, it } from 'mocha';

import schema from '../../../../server/graphql/v1/schema';
import models from '../../../../server/models';
import { fakeCollective, fakeHost, fakeTransaction, fakeUser } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

describe('server/graphql/v1/queries', () => {
  describe('TransactionInvoice', () => {
    let transaction, host, collective, fromCollective, collectiveAdmin, hostAdmin;

    before(async () => {
      await utils.resetTestDB();
      collectiveAdmin = await fakeUser();
      hostAdmin = await fakeUser();
      const hostSettings = { invoice: { templates: { default: { title: 'Hello', info: 'Not tax deductible' } } } };
      host = await fakeHost({ admin: hostAdmin, settings: hostSettings });
      collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
      fromCollective = (await fakeUser()).collective;
      transaction = await fakeTransaction(
        {
          type: 'CREDIT',
          description: 'Fake transaction for invoice test',
          CollectiveId: collective.id,
          FromCollectiveId: fromCollective.id,
          HostCollectiveId: host.id,
        },
        { createDoubleEntry: true },
      );
    });

    const transactionInvoiceQuery = gql`
      query TransactionInvoice($transactionUuid: String!) {
        TransactionInvoice(transactionUuid: $transactionUuid) {
          slug
          dateFrom
          dateTo
          year
          month
          day
          host {
            id
            settings
          }
          fromCollective {
            id
          }
          transactions {
            id
            createdAt
            description
            amount
            currency
            type
            hostCurrency
            netAmountInCollectiveCurrency
            taxAmount
            fromCollective {
              id
              slug
              name
              legalName
              type
            }
            usingGiftCardFromCollective {
              id
              slug
              name
              legalName
              type
            }
            refundTransaction {
              id
            }
            collective {
              id
              slug
              name
              legalName
              type
            }
            ... on Order {
              order {
                id
                quantity
                tier {
                  id
                  type
                }
              }
            }
          }
        }
      }
    `;

    it('must be authenticated', async () => {
      const variables = { transactionUuid: transaction.uuid };
      const result = await utils.graphqlQuery(transactionInvoiceQuery, variables, null);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to generate a receipt');
    });

    it('must be an admin of the host or the contributor profile', async () => {
      // Random user => not allowed
      const randomUser = await fakeUser();
      const variables = { transactionUuid: transaction.uuid };
      const randomUserResult = await utils.graphqlQuery(transactionInvoiceQuery, variables, randomUser);
      expect(randomUserResult.errors).to.exist;
      expect(randomUserResult.errors[0].message).to.equal('You are not allowed to download this receipt');

      // Collective admin => not allowed
      const collectiveAdminResult = await utils.graphqlQuery(transactionInvoiceQuery, variables, collectiveAdmin);
      expect(collectiveAdminResult.errors).to.exist;
      expect(randomUserResult.errors[0].message).to.equal('You are not allowed to download this receipt');

      // Host admin => allowed
      const hostAdminResult = await utils.graphqlQuery(transactionInvoiceQuery, variables, hostAdmin);
      expect(hostAdminResult.errors).to.not.exist;

      // Contributor => allowed
      const fromUser = await models.User.findOne({ where: { CollectiveId: fromCollective.id } });
      const fromCollectiveResult = await utils.graphqlQuery(transactionInvoiceQuery, variables, fromUser);
      expect(fromCollectiveResult.errors).to.not.exist;
    });

    it('returns the full invoice information', async () => {
      const variables = { transactionUuid: transaction.uuid };
      const result = await utils.graphqlQuery(transactionInvoiceQuery, variables, hostAdmin);
      const invoice = result.data.TransactionInvoice;
      expect(invoice.host.settings.invoice.templates.default.title).to.eq('Hello');
      expect(invoice.host.settings.invoice.templates.default.info).to.eq('Not tax deductible');
      const dateStr = transaction.createdAt.toISOString().split('T')[0];
      expect(invoice.slug).to.eq(`${host.name}_${dateStr}_${transaction.uuid}`);
      expect(invoice.year).to.eq(transaction.createdAt.getFullYear());
      expect(invoice.month).to.eq(transaction.createdAt.getMonth() + 1);
      expect(invoice.day).to.eq(transaction.createdAt.getDate());
      expect(invoice.host.id).to.eq(host.id);
      expect(invoice.fromCollective.id).to.eq(fromCollective.id);
      expect(invoice.transactions.length).to.eq(1);
    });
  });

  describe('Root query tests', () => {
    let user1, user2, user3, collective1, collective2, collective3, event1, event2, ticket1, ticket2;

    /* SETUP
      collective1: 2 events
        event1: 2 tiers
          ticket1: 2 orders
          ticket2: 1 order
        event2: 1 tier
          tier3: no order
      collective2: 1 event
        event3: no tiers // event3 not declared above due to linting
      collective3: no events
    */

    beforeEach(() => utils.resetTestDB());

    beforeEach(async () => {
      user1 = await models.User.createUserWithCollective(utils.data('user1'));
    });

    beforeEach(async () => {
      user2 = await models.User.createUserWithCollective(utils.data('user2'));
    });

    beforeEach(async () => {
      user3 = await models.User.createUserWithCollective(utils.data('user3'));
    });

    beforeEach(async () => {
      collective1 = await models.Collective.create(utils.data('collective1'));
    });

    beforeEach(async () => {
      collective2 = await models.Collective.create(utils.data('collective2'));
    });

    beforeEach(async () => {
      collective3 = await models.Collective.create(utils.data('collective4'));
    });

    beforeEach(() =>
      models.Collective.createMany(
        [utils.data('event1'), utils.data('event2')],
        {
          CreatedByUserId: user1.id,
          ParentCollectiveId: collective1.id,
        },
        { include: [{ association: 'location' }] },
      ).then(events => {
        event1 = events[0];
        event2 = events[1];
      }),
    );

    beforeEach(() =>
      models.Collective.create(
        Object.assign({}, utils.data('event2'), {
          slug: 'another-event',
          CreatedByUserId: user2.id,
          ParentCollectiveId: collective2.id,
        }),
        { include: [{ association: 'location' }] },
      ),
    );

    describe('returns nothing', () => {
      it('when given a non-existent slug', async () => {
        const multipleEventsQuery = gql`
          query MultipleEvents {
            allEvents(slug: "non-existent-slug") {
              id
              name
              description
            }
          }
        `;
        const req = utils.makeRequest(null);
        const result = await graphql({ schema, source: multipleEventsQuery, rootValue: null, contextValue: req });
        expect(result).to.deep.equal({
          data: {
            allEvents: [],
          },
        });
      });

      it('when given an existing collective slug when it has no events', async () => {
        const multipleEventsQuery = gql`
          query MultipleEvents($slug: String!) {
            allEvents(slug: $slug) {
              id
              name
              description
            }
          }
        `;
        const req = utils.makeRequest(null);
        const result = await graphql({
          schema,
          source: multipleEventsQuery,
          rootValue: null,
          contextValue: req,
          variableValues: { slug: collective3.slug },
        });
        expect(result).to.deep.equal({
          data: {
            allEvents: [],
          },
        });
      });
    });

    describe('returns event(s)', () => {
      it('when given an event slug and collectiveSlug (case insensitive)', async () => {
        const oneEventQuery = gql`
          query OneEvent {
            Collective(slug: "Jan-Meetup") {
              id
              name
              description
              parentCollective {
                slug
                twitterHandle
              }
              timezone
            }
          }
        `;
        const req = utils.makeRequest(null);
        const result = await graphql({ schema, source: oneEventQuery, rootValue: null, contextValue: req });
        expect(result).to.deep.equal({
          data: {
            Collective: {
              description: 'January monthly meetup',
              id: 7,
              name: 'January meetup',
              timezone: 'America/New_York',
              parentCollective: {
                slug: 'scouts',
                twitterHandle: 'scouts',
              },
            },
          },
        });
      });

      describe('returns multiple events', () => {
        it('when given only a collective slug', async () => {
          const multipleEventsQuery = gql`
            query MultipleEvents($slug: String!) {
              allEvents(slug: $slug) {
                id
                name
                description
              }
            }
          `;
          const req = utils.makeRequest(null);
          const result = await graphql({
            schema,
            source: multipleEventsQuery,
            rootValue: null,
            contextValue: req,
            variableValues: { slug: collective1.slug },
          });
          expect(result).to.deep.equal({
            data: {
              allEvents: [
                {
                  description: 'February monthly meetup',
                  id: 8,
                  name: 'Feb meetup',
                },
                {
                  description: 'January monthly meetup',
                  id: 7,
                  name: 'January meetup',
                },
              ],
            },
          });
        });
      });

      describe('returns multiple events with tiers and orders', () => {
        beforeEach(async () => {
          ticket1 = await models.Tier.create(Object.assign(utils.data('ticket1'), { CollectiveId: event1.id }));
        });

        beforeEach(async () => {
          ticket2 = await models.Tier.create(Object.assign(utils.data('ticket2'), { CollectiveId: event1.id }));
        });

        beforeEach(() => models.Tier.create(Object.assign(utils.data('ticket1'), { CollectiveId: event2.id })));

        beforeEach(() =>
          models.Order.create(
            Object.assign(utils.data('order1'), {
              CollectiveId: event1.id,
              FromCollectiveId: user2.CollectiveId,
              TierId: ticket1.id,
              CreatedByUserId: user2.id,
              processedAt: new Date(),
            }),
          ),
        );

        beforeEach(() =>
          models.Order.create(
            Object.assign(utils.data('order2'), {
              CollectiveId: event1.id,
              FromCollectiveId: user3.CollectiveId,
              TierId: ticket1.id,
              CreatedByUserId: user3.id,
              processedAt: new Date(),
            }),
          ),
        );

        // this order shouldn't show up in the query
        // because it's not confirmed
        beforeEach(() =>
          models.Order.create(
            Object.assign(utils.data('order2'), {
              CollectiveId: event1.id,
              FromCollectiveId: user1.CollectiveId,
              TierId: ticket1.id,
              CreatedByUserId: user1.id,
              processedAt: null,
            }),
          ),
        );

        beforeEach(() =>
          models.Order.create(
            Object.assign(utils.data('order3'), {
              CollectiveId: event1.id,
              FromCollectiveId: user3.CollectiveId,
              TierId: ticket2.id,
              CreatedByUserId: user3.id,
              processedAt: new Date(),
            }),
          ),
        );

        it('sends order data', async () => {
          const query = gql`
            query getOneCollective($slug: String!) {
              Collective(slug: $slug) {
                orders {
                  createdAt
                }
              }
            }
          `;
          const req = utils.makeRequest(null);
          const result = await graphql({
            schema,
            source: query,
            rootValue: null,
            contextValue: req,
            variableValues: { slug: event1.slug },
          });
          result.errors && console.error(result.errors);
          const order = result.data.Collective.orders[0];
          expect(order).to.have.property('createdAt');
        });

        it('when given only a collective slug1', async () => {
          const allEventsQuery = gql`
            query AllEvents($slug: String!) {
              allEvents(slug: $slug) {
                id
                name
                description
                location {
                  name
                  address
                }
                backgroundImage
                createdByUser {
                  id
                }
                tiers {
                  id
                  name
                  description
                  maxQuantity
                  stats {
                    availableQuantity
                    totalOrders
                  }
                  orders {
                    id
                    description
                    createdByUser {
                      id
                    }
                  }
                }
              }
            }
          `;
          const req = utils.makeRequest(null);
          const result = await graphql({
            schema,
            source: allEventsQuery,
            rootValue: null,
            contextValue: req,
            variableValues: { slug: collective1.slug },
          });
          const expectedResult = {
            data: {
              allEvents: [
                {
                  id: 8,
                  name: 'Feb meetup',
                  description: 'February monthly meetup',
                  location: {
                    name: 'Puck Fair',
                    address: '505 Broadway, NY 10012',
                  },
                  backgroundImage: null,
                  createdByUser: { id: 1 },
                  tiers: [
                    {
                      id: 3,
                      name: 'Free ticket',
                      description: 'free tickets for all',
                      maxQuantity: 10,
                      stats: { availableQuantity: 10, totalOrders: 0 },
                      orders: [],
                    },
                  ],
                },
                {
                  id: 7,
                  name: 'January meetup',
                  description: 'January monthly meetup',
                  location: {
                    name: 'Balanced NYC',
                    address: '547 Broadway, NY 10012',
                  },
                  backgroundImage: 'http://opencollective.com/backgroundimage.png',
                  createdByUser: { id: 1 },
                  tiers: [
                    {
                      id: 1,
                      name: 'Free ticket',
                      description: 'free tickets for all',
                      maxQuantity: 10,
                      stats: { availableQuantity: 7, totalOrders: 2 },
                      orders: [
                        {
                          id: 1,
                          description: 'I work on bitcoin',
                          createdByUser: { id: 2 },
                        },
                        {
                          id: 2,
                          description: 'I have been working on open source for over a decade',
                          createdByUser: { id: 3 },
                        },
                        {
                          id: 3,
                          description: 'I have been working on open source for over a decade',
                          createdByUser: {
                            id: 1,
                          },
                        },
                      ],
                    },
                    {
                      id: 2,
                      name: 'paid ticket',
                      description: '$20 ticket',
                      maxQuantity: 100,
                      stats: { availableQuantity: 98, totalOrders: 1 },
                      orders: [
                        {
                          id: 4,
                          description: null,
                          createdByUser: { id: 3 },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          };
          expect(result).to.deep.equal(expectedResult);
        });
      });
    });
  });
});

import { expect } from 'chai';
import gql from 'fake-tag';
import { graphql } from 'graphql';
import { describe, it } from 'mocha';

import schema from '../../../../server/graphql/v1/schema';
import models from '../../../../server/models';
import * as utils from '../../../utils';

describe('server/graphql/v1/query', () => {
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

  describe('Root query tests', () => {
    beforeEach(() =>
      models.Collective.createMany([utils.data('event1'), utils.data('event2')], {
        CreatedByUserId: user1.id,
        ParentCollectiveId: collective1.id,
      }).then(events => {
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
        const result = await graphql(schema, multipleEventsQuery, null, req);
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
        const result = await graphql(schema, multipleEventsQuery, null, req, { slug: collective3.slug });
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
        const result = await graphql(schema, oneEventQuery, null, req);
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
          const result = await graphql(schema, multipleEventsQuery, null, req, { slug: collective1.slug });
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
          const result = await graphql(schema, query, null, req, { slug: event1.slug });
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
                  firstName
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
                      firstName
                    }
                  }
                }
              }
            }
          `;
          const req = utils.makeRequest(null);
          const result = await graphql(schema, allEventsQuery, null, req, { slug: collective1.slug });
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
                  createdByUser: { id: 1, firstName: null },
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
                  createdByUser: { id: 1, firstName: null },
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
                          createdByUser: { id: 2, firstName: null },
                        },
                        {
                          id: 2,
                          description: 'I have been working on open source for over a decade',
                          createdByUser: { id: 3, firstName: null },
                        },
                        {
                          id: 3,
                          description: 'I have been working on open source for over a decade',
                          createdByUser: {
                            id: 1,
                            firstName: null,
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
                          createdByUser: { id: 3, firstName: null },
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

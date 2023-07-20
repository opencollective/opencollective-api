import * as chai from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';
import { assert, createSandbox, match } from 'sinon';

import roles from '../../../../server/constants/roles.js';
import * as CacheLib from '../../../../server/lib/cache/index.js';
import emailLib from '../../../../server/lib/email.js';
import * as payments from '../../../../server/lib/payments.js';
import models from '../../../../server/models/index.js';
import { fakeOrder, fakePaymentMethod, fakeProject, fakeUser } from '../../../test-helpers/fake-data.js';
import * as utils from '../../../utils.js';

let host, user1, user2, user3, collective1, event1, ticket1;
let sandbox, executeOrderStub, emailSendSpy, emailSendMessageSpy;

const { expect } = chai;

describe('server/graphql/v1/mutation', () => {
  /* SETUP
    collective1: 2 events
      event1: 1 free ticket, 1 paid ticket
  */

  before(() => {
    sandbox = createSandbox();
    emailSendSpy = sandbox.spy(emailLib, 'send');
    emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
    executeOrderStub = sandbox.stub(payments, 'executeOrder').callsFake((user, order) => {
      // assumes payment goes through and marks Order as confirmedAt
      return models.Tier.findByPk(order.TierId)
        .then(tier => {
          if (tier.interval) {
            return models.Subscription.create({
              amount: tier.amount,
              currency: tier.currency,
              interval: tier.interval,
              isActive: true,
            }).then(s => s.id);
          }
        })
        .then(SubscriptionId => order.update({ SubscriptionId, processedAt: new Date() }))
        .then(() => models.Collective.findByPk(order.CollectiveId))
        .then(collective =>
          collective.addUserWithRole(
            user,
            roles.BACKER,
            { MemberCollectiveId: order.FromCollectiveId, TierId: order.TierId },
            { order },
          ),
        );
    });
  });

  after(() => sandbox.restore());

  beforeEach('reset db', async () => {
    await new Promise(res => setTimeout(res, 500));
    await utils.resetTestDB();
  });

  beforeEach('create user1', async () => {
    user1 = await models.User.createUserWithCollective(utils.data('user1'));
  });
  beforeEach('create host user 1', async () => {
    host = await models.User.createUserWithCollective({
      ...utils.data('host1'),
      currency: 'EUR',
    });
  });

  beforeEach('create user2', async () => {
    user2 = await models.User.createUserWithCollective(utils.data('user2'));
  });
  beforeEach('create user3', async () => {
    user3 = await models.User.createUserWithCollective(utils.data('user3'));
  });
  beforeEach('create collective1', async () => {
    collective1 = await models.Collective.create(utils.data('collective1'));
  });
  beforeEach('add host', () => collective1.addHost(host.collective, host));
  beforeEach('add user1 as admin to collective1', () => collective1.addUserWithRole(user1, roles.ADMIN));
  beforeEach('add user2 as admin to collective1', () => collective1.addUserWithRole(user2, roles.ADMIN));

  beforeEach('create stripe account', async () => {
    await models.ConnectedAccount.create({
      service: 'stripe',
      token: 'abc',
      CollectiveId: host.collective.id,
    });
  });

  beforeEach('create an event collective', async () => {
    event1 = await models.Collective.create(
      Object.assign(utils.data('event1'), {
        CreatedByUserId: user1.id,
        ParentCollectiveId: collective1.id,
        HostCollectiveId: collective1.HostCollectiveId,
        isActive: true,
        approvedAt: new Date(),
      }),
    );
  });

  beforeEach('create a project  under collective1', async () => {
    await fakeProject({
      ParentCollectiveId: collective1.id,
      HostCollectiveId: collective1.HostCollectiveId,
      isActive: true,
      approvedAt: new Date(),
    });
  });

  describe('createCollective tests', () => {
    const createCollectiveMutation = gql`
      mutation CreateCollective($collective: CollectiveInputType!) {
        createCollective(collective: $collective) {
          id
          slug
          currency
          hostFeePercent
          host {
            id
            currency
          }
          parentCollective {
            id
            currency
          }
          isActive
          tiers {
            id
            name
            amount
            presets
          }
        }
      }
    `;

    describe('creates an event collective', () => {
      const getEventData = collective => {
        return {
          name: 'BrusselsTogether Meetup 3',
          type: 'EVENT',
          longDescription:
            'Hello Brussels!\n\nAccording to the UN, by 2050 66% of the world’s population will be urban dwellers, which will profoundly affect the role of modern city-states on Earth.\n\nToday, citizens are already anticipating this futurist trend by creating numerous initiatives inside their local communities and outside of politics.\n\nIf you want to be part of the change, please come have a look to our monthly events! You will have the opportunity to meet real actors of change and question them about their purpose. \n\nWe also offer the opportunity for anyone interested to come before the audience and share their ideas in 60 seconds at the end of the event.\n\nSee more about #BrusselsTogether radical way of thinking below.\n\nhttps://brusselstogether.org/\n\nGet your ticket below and get a free drink thanks to our sponsor! 🍻🎉\n\n**Schedule**\n\n7 pm - Doors open\n\n7:30 pm - Introduction to #BrusselsTogether\n\n7:40 pm - Co-Labs, Citizen Lab of Social Innovations\n\n7:55 pm - BeCode.org, growing today’s talented youth into tomorrow’s best developers.\n\n8:10 pm - OURB, A city building network\n\n8:30 pm - How do YOU make Brussels better \nPitch your idea in 60 seconds or less\n',
          location: {
            name: "Brass'Art Digitaal Cafe",
            address: 'Place communale de Molenbeek 28',
          },
          startsAt: 'Wed Apr 05 2017 10:00:00 GMT-0700 (PDT)',
          endsAt: 'Wed Apr 05 2017 12:00:00 GMT-0700 (PDT)',
          timezone: 'Europe/Brussels',
          ParentCollectiveId: collective.id,
          tiers: [
            { name: 'free ticket', description: 'Free ticket', amount: 0 },
            {
              name: 'sponsor',
              description: 'Sponsor the drinks. Pretty sure everyone will love you.',
              amount: 15000,
            },
          ],
        };
      };

      it('fails if not authenticated', async () => {
        const result = await utils.graphqlQuery(createCollectiveMutation, {
          collective: getEventData(collective1),
        });
        expect(result.errors).to.have.length(1);
        expect(result.errors[0].message).to.equal('You need to be logged in to create a collective');
      });

      it('fails if authenticated but cannot edit parent collective', async () => {
        await host.collective.update({ settings: { apply: true } });
        const result = await utils.graphqlQuery(
          createCollectiveMutation,
          { collective: getEventData(collective1) },
          user3,
        );
        expect(result.errors).to.have.length(1);
        expect(result.errors[0].message).to.equal(
          'You must be logged in as a member of the scouts collective to create an event',
        );
      });

      it('creates an event with multiple tiers, uses the currency of parent collective and inherit fees', async () => {
        await host.collective.update({
          currency: 'CAD',
          settings: { apply: true },
          hostFeePercent: 10,
        });
        const event = getEventData(collective1);

        const result = await utils.graphqlQuery(createCollectiveMutation, { collective: event }, user1);
        result.errors && console.error(result.errors[0]);
        const createdEvent = result.data.createCollective;
        expect(createdEvent.slug).to.contain('brusselstogether-meetup');
        expect(createdEvent.tiers.length).to.equal(event.tiers.length);
        expect(createdEvent.hostFeePercent).to.equal(10);
        expect(createdEvent.isActive).to.be.true;
        event.id = createdEvent.id;
        event.tiers = createdEvent.tiers;

        // Make sure the creator of the event has been added as an ADMIN
        const members = await models.Member.findAll({
          where: { CollectiveId: event.id },
          order: [['MemberCollectiveId', 'ASC']],
        });
        expect(createdEvent.currency).to.equal(createdEvent.parentCollective.currency);
        expect(members).to.have.length(1);
        expect(members[0].role).to.equal(roles.HOST);
        expect(members[0].MemberCollectiveId).to.equal(collective1.HostCollectiveId);

        // We remove the first tier
        event.tiers.shift();

        // We update the second (now only) tier
        event.tiers[0].amount = 123;

        const updateQuery = gql`
          mutation editCollective($collective: CollectiveInputType!) {
            editCollective(collective: $collective) {
              id
              slug
              tiers {
                id
                name
                amount
              }
            }
          }
        `;

        const r2 = await utils.graphqlQuery(updateQuery, { collective: event });
        expect(r2.errors).to.have.length(1);
        expect(r2.errors[0].message).to.equal('You need to be logged in to edit a collective');

        const r3 = await utils.graphqlQuery(updateQuery, { collective: event }, user3);
        expect(r3.errors).to.have.length(1);
        expect(r3.errors[0].message).to.equal(
          'You must be logged in as admin of the scouts collective to edit this Event.',
        );

        const r4 = await utils.graphqlQuery(updateQuery, { collective: event }, user1);
        const updatedEvent = r4.data.editCollective;
        expect(updatedEvent.tiers.length).to.equal(event.tiers.length);
        expect(updatedEvent.tiers[0].amount).to.equal(event.tiers[0].amount);
      });
    });
  });

  describe('editCollective tests', () => {
    describe('edit tiers', () => {
      const editTiersMutation = gql`
        mutation EditTiers($id: Int!, $tiers: [TierInputType]) {
          editTiers(id: $id, tiers: $tiers) {
            id
            name
            type
            amount
            interval
            goal
          }
        }
      `;

      const tiers = [
        { name: 'backer', type: 'TIER', amount: 10000, interval: 'month' },
        { name: 'sponsor', type: 'TIER', amount: 500000, interval: 'year' },
      ];

      it('fails if not authenticated', async () => {
        const result = await utils.graphqlQuery(editTiersMutation, {
          id: collective1.id,
          tiers,
        });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('You need to be logged in to edit tiers');
      });

      it('fails if not authenticated as host or member of collective', async () => {
        const result = await utils.graphqlQuery(editTiersMutation, { id: collective1.id }, user3);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal(
          "You need to be logged in as a core contributor or as a host of the Scouts d'Arlon collective",
        );
      });

      it('add new tiers and update existing', async () => {
        const result = await utils.graphqlQuery(editTiersMutation, { id: collective1.id, tiers }, user1);
        result.errors && console.error(result.errors[0]);
        expect(tiers).to.have.length(2);
        tiers.sort((a, b) => b.amount - a.amount);
        expect(tiers[0].interval).to.equal('year');
        expect(tiers[1].interval).to.equal('month');
        tiers[0].goal = 20000;
        tiers[1].amount = 100000;
        tiers.push({ name: 'free ticket', type: 'TICKET', amount: 0 });
        const result2 = await utils.graphqlQuery(editTiersMutation, { id: collective1.id, tiers }, user1);
        result2.errors && console.error(result2.errors[0]);
        const updatedTiers = result2.data.editTiers;
        updatedTiers.sort((a, b) => b.amount - a.amount);
        expect(updatedTiers).to.have.length(3);
        expect(updatedTiers[0].goal).to.equal(tiers[0].goal);
        expect(updatedTiers[1].amount).to.equal(tiers[1].amount);
      });
    });

    describe('change the hostFeePercent of the host', () => {
      const updateHostFeePercentMutation = gql`
        mutation UpdateHostFeePercent($collective: CollectiveInputType!) {
          editCollective(collective: $collective) {
            id
            slug
            hostFeePercent
            host {
              id
              hostFeePercent
            }
          }
        }
      `;

      it('fails if not authenticated as an admin of the host', async () => {
        const result = await utils.graphqlQuery(
          updateHostFeePercentMutation,
          { collective: { id: collective1.id, hostFeePercent: 11 } },
          user1,
        );
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.contain(
          'Only an admin of the host collective can edit the host fee for this collective',
        );
      });

      it('updates the hostFeePercent of the collective, not of the host', async () => {
        const result = await utils.graphqlQuery(
          updateHostFeePercentMutation,
          { collective: { id: collective1.id, hostFeePercent: 11 } },
          host,
        );
        expect(result.data.editCollective.hostFeePercent).to.equal(11);
        expect(result.data.editCollective.host.hostFeePercent).to.equal(10);
      });

      it('updates the hostFeePercent of the host and of the hosted collectives', async () => {
        const result = await utils.graphqlQuery(
          updateHostFeePercentMutation,
          { collective: { id: host.collective.id, hostFeePercent: 9 } },
          host,
        );
        expect(result.data.editCollective.hostFeePercent).to.equal(9);
        const hostedCollectives = await models.Collective.findAll({ where: { HostCollectiveId: host.collective.id } });
        hostedCollectives.map(c => {
          expect(c.hostFeePercent).to.equal(9);
        });
      });
    });

    describe('archives a collective', () => {
      const archiveCollectiveMutation = gql`
        mutation ArchiveCollective($id: Int!) {
          archiveCollective(id: $id) {
            id
            isArchived
          }
        }
      `;
      const unarchiveCollectiveMutation = gql`
        mutation UnarchiveCollective($id: Int!) {
          unarchiveCollective(id: $id) {
            id
            isArchived
          }
        }
      `;

      after(async () => {
        await utils.graphqlQuery(unarchiveCollectiveMutation, { id: collective1.id }, user3);
      });

      it('fails if not authenticated', async () => {
        const result = await utils.graphqlQuery(archiveCollectiveMutation, {
          id: collective1.id,
        });

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('You need to be logged in to archive a collective');
      });

      it('fails if not authenticated as an Admin', async () => {
        const result = await utils.graphqlQuery(archiveCollectiveMutation, { id: collective1.id }, user3);

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('You need to be logged in as an Admin.');
      });

      it('should archive its children projects and events', async () => {
        await utils.graphqlQuery(archiveCollectiveMutation, { id: collective1.id }, user1);

        const projects = (await collective1.getProjects()).map(p => ({ id: p.id, name: p.name, isActive: p.isActive }));
        const events = (await collective1.getEvents()).map(p => ({ id: p.id, name: p.name, isActive: p.isActive }));

        expect(projects.length).to.eq(1);
        expect(events.length).to.eq(1);
        projects.forEach(project => expect(project.isActive).to.eq(false));
        events.forEach(event => expect(event.isActive).to.eq(false));
      });

      it('archives a project should cancel recurring contributions', async () => {
        // Setup test data
        const admin = await fakeUser();
        const project = await fakeProject({ admin });
        const order = await fakeOrder(
          { CollectiveId: project.id, status: 'ACTIVE', subscription: { isManagedExternally: true } },
          { withSubscription: true },
        );

        // Setup some spies
        const purgeCacheSpy = sandbox.spy(CacheLib, 'purgeCacheForCollective');

        // Call mutation
        const response = await utils.graphqlQuery(archiveCollectiveMutation, { id: project.id }, admin);
        expect(response.data.archiveCollective.isArchived).to.be.true;

        // Check DB entries
        await project.reload();
        await order.reload();
        expect(project.isActive).to.be.false;
        expect(project.HostCollectiveId).to.be.null;
        expect(project.deactivatedAt).to.be.a('date');
        expect(order.status).to.equal('CANCELLED');

        // Check API calls
        expect(purgeCacheSpy.callCount).to.equal(2);
        expect(purgeCacheSpy.firstCall.args[0]).to.equal(project.slug);
        expect(purgeCacheSpy.secondCall.args[0]).to.equal((await project.getParentCollective()).slug);
      });
    });
  });

  describe('createOrder tests', () => {
    beforeEach('create ticket 1', async () => {
      ticket1 = await models.Tier.create(Object.assign(utils.data('ticket1'), { CollectiveId: event1.id }));
    });

    beforeEach('create ticket 2', () =>
      models.Tier.create(Object.assign(utils.data('ticket2'), { CollectiveId: event1.id })),
    );

    beforeEach('create tier 1', () =>
      models.Tier.create(Object.assign(utils.data('tier1'), { CollectiveId: collective1.id })),
    );

    describe('throws an error', () => {
      it('when missing all required fields', async () => {
        const createOrderMutation = gql`
          mutation CreateOrder($order: OrderInputType!) {
            createOrder(order: $order) {
              id
              collective {
                id
              }
              tier {
                id
                name
                description
              }
            }
          }
        `;

        const result = await utils.graphqlQuery(createOrderMutation, { order: {} });
        expect(result.errors.length).to.equal(1);
        expect(result.errors[0].message).to.contain('collective');
      });

      describe("when collective/tier doesn't exist", () => {
        it("when collective doesn't exist", async () => {
          const createOrderMutation = gql`
            mutation createOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id
                collective {
                  id
                }
                tier {
                  id
                  name
                  description
                }
              }
            }
          `;
          const order = {
            collective: { id: 12324 },
            tier: { id: 3 },
            quantity: 1,
          };
          const result = await utils.graphqlQuery(createOrderMutation, { order }, user2);
          expect(result.errors.length).to.equal(1);
          expect(result.errors[0].message).to.equal(`No collective found: ${order.collective.id}`);
        });

        it("when tier doesn't exist", async () => {
          const createOrderMutation = gql`
            mutation CreateOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id
                collective {
                  id
                }
                tier {
                  id
                  name
                  description
                }
              }
            }
          `;

          const order = {
            collective: { id: event1.id },
            tier: { id: 1002 },
            quantity: 1,
          };
          const result = await utils.graphqlQuery(createOrderMutation, { order }, user2);
          expect(result.errors.length).to.equal(1);
          expect(result.errors[0].message).to.equal(`A tier must be provided when totalAmount is not set`);
        });
      });

      describe('after checking ticket quantity', () => {
        it('and if not enough are available', async () => {
          const createOrderMutation = gql`
            mutation CreateOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id
                collective {
                  id
                }
                tier {
                  id
                  name
                  description
                }
              }
            }
          `;

          const order = {
            collective: { id: event1.id },
            tier: { id: 3 },
            quantity: 101,
          };
          const result = await utils.graphqlQuery(createOrderMutation, { order }, user2);
          expect(result.errors[0].message).to.equal(`No more tickets left for ${ticket1.name}`);
        });
      });

      describe('when no payment method', () => {
        it("and it's a paid ticket", async () => {
          const createOrderMutation = gql`
            mutation CreateOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id
                collective {
                  id
                }
                tier {
                  id
                  name
                  description
                }
              }
            }
          `;

          const order = {
            collective: { id: event1.id },
            tier: { id: 4 },
            quantity: 2,
          };
          const result = await utils.graphqlQuery(createOrderMutation, { order }, user2);
          expect(result.errors[0].message).to.equal('This order requires a payment method');
        });
      });
    });

    describe('creates an order', () => {
      beforeEach('reset spies', () => {
        executeOrderStub.resetHistory();
        emailSendSpy.resetHistory();
        emailSendMessageSpy.resetHistory();
      });

      describe('as an organization', () => {
        const createOrderMutation = gql`
          mutation CreateOrder($order: OrderInputType!) {
            createOrder(order: $order) {
              id
              tier {
                id
              }
              fromCollective {
                slug
                twitterHandle
              }
              collective {
                id
                slug
              }
            }
          }
        `;

        it('as a new organization', async () => {
          const order = {
            fromCollective: {
              name: 'Google',
              website: 'https://google.com',
              twitterHandle: 'google',
            },
            paymentMethod: {
              token: 'tok_123456781234567812345678',
              service: 'stripe',
              name: '4242',
              data: {
                expMonth: 11,
                expYear: 2020,
              },
            },
            collective: { id: collective1.id },
            publicMessage: 'Looking forward!',
            tier: { id: 5 },
            quantity: 2,
          };
          emailSendMessageSpy.resetHistory();
          const result = await utils.graphqlQuery(createOrderMutation, { order }, user2);
          result.errors && console.error(result.errors);
          expect(result.data).to.deep.equal({
            createOrder: {
              fromCollective: {
                slug: 'google',
                twitterHandle: 'google',
              },
              collective: {
                id: collective1.id,
                slug: collective1.slug,
              },
              id: 1,
              tier: {
                id: 5,
              },
            },
          });

          // Make sure we have added the user as a BACKER
          const members = await models.Member.findAll({
            where: {
              CollectiveId: collective1.id,
              role: roles.BACKER,
            },
          });
          await utils.waitForCondition(() => emailSendMessageSpy.callCount === 3);
          // utils.inspectSpy(emailSendMessageSpy, 2);
          expect(members).to.have.length(1);

          // Make sure we send the collective.member.created email notification to core contributor of collective1
          expect(emailSendMessageSpy.callCount).to.equal(3);
          // utils.inspectSpy(emailSendMessageSpy, 2);
          assert.calledWithMatch(
            emailSendMessageSpy,
            'user2@opencollective.com',
            'Your Organization on Open Collective',
          );
          assert.calledWithMatch(
            emailSendMessageSpy,
            'user1@opencollective.com',
            "New financial contributor to Scouts d'Arlon: Google ($20.00/m)",
          );
          expect(emailSendMessageSpy.secondCall.args[2]).to.contain('Looking forward!'); // publicMessage
          expect(emailSendMessageSpy.secondCall.args[2]).to.contain(
            '@google thanks for your financial contribution to @scouts',
          );
        });

        it('as an existing organization', async () => {
          const org = await models.Collective.create({
            type: 'ORGANIZATION',
            name: 'Slack',
            website: 'https://slack.com',
            description: 'Supporting open source since 1999',
            twitterHandle: 'slack',
            image: 'http://www.endowmentwm.com/wp-content/uploads/2017/07/slack-logo.png',
          });

          await org.addUserWithRole(user2, roles.ADMIN);

          const order = {
            fromCollective: {
              id: org.id,
            },
            paymentMethod: {
              token: 'tok_123456781234567812345678',
              service: 'stripe',
              name: '4242',
              data: {
                expMonth: 11,
                expYear: 2020,
              },
            },
            collective: { id: collective1.id },
            publicMessage: 'Looking forward!',
            tier: { id: 5 },
            quantity: 2,
          };
          const result = await utils.graphqlQuery(createOrderMutation, { order }, user2);
          result.errors && console.error(result.errors);
          expect(result.data).to.deep.equal({
            createOrder: {
              fromCollective: {
                slug: 'slack',
                twitterHandle: 'slack',
              },
              collective: {
                id: collective1.id,
                slug: collective1.slug,
              },
              id: 1,
              tier: {
                id: 5,
              },
            },
          });

          // Make sure we have added the user as a BACKER
          const members = await models.Member.findAll({
            where: {
              CollectiveId: collective1.id,
              role: roles.BACKER,
            },
          });
          expect(members).to.have.length(1);
          await utils.waitForCondition(() => emailSendMessageSpy.callCount > 1);
          expect(emailSendSpy.callCount).to.equal(2);
          const activityData = emailSendSpy.lastCall.args[2];
          expect(activityData.member.role).to.equal(roles.BACKER);
          expect(activityData.collective.type).to.equal('COLLECTIVE');
          expect(activityData.order.publicMessage).to.equal('Looking forward!');
          expect(activityData.order.subscription.interval).to.equal('month');
          expect(activityData.collective.slug).to.equal(collective1.slug);
          expect(activityData.member.memberCollective.slug).to.equal('slack');
          assert.calledWithMatch(emailSendSpy, 'collective.member.created');
          assert.calledWithMatch(emailSendMessageSpy, user2.email);
        });
      });

      describe('in a free ticket', () => {
        it('from an existing user', async () => {
          const createOrderMutation = gql`
            mutation CreateOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id
                createdByUser {
                  id
                  email
                }
                tier {
                  id
                  name
                  description
                  maxQuantity
                  stats {
                    totalOrders
                    availableQuantity
                  }
                }
                fromCollective {
                  id
                  slug
                }
                collective {
                  id
                  slug
                }
              }
            }
          `;

          const order = {
            collective: { id: event1.id },
            publicMessage: 'Looking forward!',
            tier: { id: 3 },
            quantity: 2,
          };
          const result = await utils.graphqlQuery(createOrderMutation, { order }, user2);
          result.errors && console.error(result.errors);
          expect(result.data).to.deep.equal({
            createOrder: {
              fromCollective: {
                id: user2.CollectiveId,
                slug: user2.collective.slug,
              },
              collective: {
                id: event1.id,
                slug: event1.slug,
              },
              id: 1,
              tier: {
                description: 'free tickets for all',
                id: 3,
                maxQuantity: 10,
                name: 'Free ticket',
                stats: {
                  availableQuantity: 8,
                  totalOrders: 1,
                },
              },
              createdByUser: {
                email: user2.email,
                id: 3,
              },
            },
          });

          // Make sure we have added the user as an ATTENDEE
          const members = await models.Member.findAll({
            where: {
              CollectiveId: event1.id,
              role: roles.ATTENDEE,
            },
          });
          expect(members).to.have.length(1);
          // 2 for the collective admins, 1 for the contributor
          await utils.waitForCondition(() => emailSendSpy.callCount === 3);
          expect(emailSendSpy.callCount).to.equal(3);
          const activityData = emailSendSpy.args.find(arg => arg[0] === 'collective.member.created')[2];
          expect(activityData.member.role).to.equal('ATTENDEE');
          expect(activityData.collective.type).to.equal('EVENT');
          expect(activityData.order.publicMessage).to.equal('Looking forward!');
          expect(activityData.collective.slug).to.equal(event1.slug);
          expect(activityData.member.memberCollective.slug).to.equal(user2.collective.slug);

          assert.calledWithMatch(emailSendSpy, 'collective.member.created');
          assert.calledWithMatch(emailSendSpy, 'collective.member.created');
          assert.calledWithMatch(emailSendSpy, 'ticket.confirmed');
          expect(emailSendMessageSpy.callCount).to.equal(3);
          assert.calledWithMatch(
            emailSendMessageSpy,
            'user1@opencollective.com',
            'New financial contributor to January meetup: Anish Bas',
          );
          assert.calledWithMatch(
            emailSendMessageSpy,
            'user2@opencollective.com',
            'New financial contributor to January meetup: Anish Bas',
          );
          assert.calledWithMatch(
            emailSendMessageSpy,
            'user2@opencollective.com',
            '2 tickets confirmed for January meetup',
          );
        });

        it('from a new user', async () => {
          const createOrderMutation = gql`
            mutation CreateOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id
                createdByUser {
                  id
                  email
                }
                tier {
                  id
                  name
                  description
                  maxQuantity
                  stats {
                    availableQuantity
                  }
                }
              }
            }
          `;

          const order = {
            collective: { id: event1.id },
            tier: { id: 3 },
            quantity: 2,
          };
          const remoteUser = await models.User.createUserWithCollective({
            email: 'newuser@email.com',
          });
          const result = await utils.graphqlQuery(createOrderMutation, { order }, remoteUser);
          result.errors && console.error(result.errors);
          expect(result).to.deep.equal({
            data: {
              createOrder: {
                id: 1,
                tier: {
                  description: 'free tickets for all',
                  id: 3,
                  maxQuantity: 10,
                  name: 'Free ticket',
                  stats: {
                    availableQuantity: 8,
                  },
                },
                createdByUser: {
                  email: 'newuser@email.com',
                  id: 6,
                },
              },
            },
          });

          // Make sure we have added the user as an ATTENDEE
          const members = await models.Member.findAll({
            where: {
              CollectiveId: event1.id,
              role: roles.ATTENDEE,
            },
          });
          expect(members).to.have.length(1);
        });
      });

      describe('in a paid ticket', () => {
        it('from an existing user', async () => {
          const createOrderMutation = gql`
            mutation CreateOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id
                createdByUser {
                  id
                  email
                }
                tier {
                  id
                  name
                  description
                  maxQuantity
                  stats {
                    availableQuantity
                  }
                }
                collective {
                  id
                  slug
                }
              }
            }
          `;

          const order = {
            paymentMethod: {
              token: 'tok_123456781234567812345678',
              service: 'stripe',
              name: '4242',
              data: {
                expMonth: 11,
                expYear: 2020,
              },
            },
            collective: { id: event1.id },
            tier: { id: 4 },
            quantity: 2,
          };
          const result = await utils.graphqlQuery(createOrderMutation, { order }, user2);
          result.errors && console.error(result.errors[0]);
          expect(result.data).to.deep.equal({
            createOrder: {
              id: 1,
              tier: {
                stats: {
                  availableQuantity: 98,
                },
                description: '$20 ticket',
                id: 4,
                maxQuantity: 100,
                name: 'paid ticket',
              },
              createdByUser: {
                email: user2.email,
                id: 3,
              },
              collective: {
                id: event1.id,
                slug: 'jan-meetup',
              },
            },
          });
          const executeOrderArgument = executeOrderStub.firstCall.args;
          expect(executeOrderStub.callCount).to.equal(1);
          executeOrderStub.resetHistory();
          expect(executeOrderArgument[1].id).to.equal(1);
          expect(executeOrderArgument[1].TierId).to.equal(4);
          expect(executeOrderArgument[1].CollectiveId).to.equal(6);
          expect(executeOrderArgument[1].CreatedByUserId).to.equal(3);
          expect(executeOrderArgument[1].totalAmount).to.equal(4000);
          expect(executeOrderArgument[1].currency).to.equal('USD');
          expect(executeOrderArgument[1].paymentMethod.token).to.equal('tok_123456781234567812345678');
          await utils.waitForCondition(() => emailSendMessageSpy.callCount === 2);
          expect(emailSendMessageSpy.callCount).to.equal(2);
          assert.calledWithMatch(
            emailSendMessageSpy,
            user1.email,
            `New financial contributor to ${event1.name}: Anish Bas ($40.00)`,
          );
          assert.calledWithMatch(
            emailSendMessageSpy,
            user2.email,
            'New financial contributor to January meetup: Anish Bas ($40.00)',
            match('/scouts/events/jan-meetup'),
          );
        });

        describe('from an existing but logged out user', async () => {
          const createOrderMutation = gql`
            mutation CreateOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id
                createdByUser {
                  id
                  email
                }
                tier {
                  id
                  name
                  description
                  maxQuantity
                  stats {
                    availableQuantity
                  }
                }
                collective {
                  id
                  slug
                }
              }
            }
          `;

          it('works with an order that has only fresh info', async () => {
            const order = {
              paymentMethod: {
                token: 'tok_123456781234567812345678',
                service: 'stripe',
                name: '4242',
                data: {
                  expMonth: 11,
                  expYear: 2020,
                },
              },
              collective: { id: event1.id },
              tier: { id: 4 },
              quantity: 2,
              guestInfo: {
                email: user2.email,
                captcha: { token: '10000000-aaaa-bbbb-cccc-000000000001', provider: 'HCAPTCHA' },
              },
            };

            const loggedInUser = null;
            const result = await utils.graphqlQuery(createOrderMutation, { order }, loggedInUser);
            result.errors && console.error(result.errors[0]);
            expect(result.errors).to.not.exist;
            expect(result.data).to.deep.equal({
              createOrder: {
                id: 1,
                tier: {
                  stats: {
                    availableQuantity: 98,
                  },
                  description: '$20 ticket',
                  id: 4,
                  maxQuantity: 100,
                  name: 'paid ticket',
                },
                createdByUser: {
                  email: null,
                  id: 3,
                },
                collective: {
                  id: event1.id,
                  slug: 'jan-meetup',
                },
              },
            });
          });

          it('cannot use an existing payment method', async () => {
            const user2PaymentMethod = await fakePaymentMethod({
              CollectiveId: user2.CollectiveId,
              service: 'opencollective',
              type: 'prepaid',
            });
            const order = {
              paymentMethod: { id: user2PaymentMethod.id },
              collective: { id: event1.id },
              tier: { id: 4 },
              quantity: 2,
              guestInfo: { email: user2.email },
            };

            const loggedInUser = null;
            const result = await utils.graphqlQuery(createOrderMutation, { order }, loggedInUser);
            expect(result.errors).to.exist;
            expect(result.errors[0].message).to.equal(
              'You need to be logged in to be able to use an existing payment method',
            );
          });
        });

        it('from a new user', async () => {
          const createOrderMutation = gql`
            mutation CreateOrder($order: OrderInputType!) {
              createOrder(order: $order) {
                id
                createdByUser {
                  id
                  email
                }
                tier {
                  id
                  name
                  description
                  maxQuantity
                  stats {
                    availableQuantity
                  }
                }
                collective {
                  id
                  slug
                }
              }
            }
          `;

          const order = {
            paymentMethod: {
              token: 'tok_123456781234567812345678',
              name: '4242',
              data: {
                expMonth: 11,
                expYear: 2020,
              },
            },
            collective: { id: event1.id },
            tier: { id: 4 },
            quantity: 2,
          };
          const remoteUser = await models.User.createUserWithCollective({ email: 'newuser@email.com' });
          const result = await utils.graphqlQuery(createOrderMutation, { order }, remoteUser);
          result.errors && console.error(result.errors[0]);
          const executeOrderArgument = executeOrderStub.firstCall.args;
          expect(result).to.deep.equal({
            data: {
              createOrder: {
                id: 1,
                tier: {
                  description: '$20 ticket',
                  id: 4,
                  maxQuantity: 100,
                  name: 'paid ticket',
                  stats: {
                    availableQuantity: 98,
                  },
                },
                createdByUser: {
                  email: 'newuser@email.com',
                  id: 6,
                },
                collective: {
                  id: 6,
                  slug: 'jan-meetup',
                },
              },
            },
          });

          expect(executeOrderStub.callCount).to.equal(1);
          expect(executeOrderArgument[1].id).to.equal(1);
          expect(executeOrderArgument[1].TierId).to.equal(4);
          expect(executeOrderArgument[1].CollectiveId).to.equal(6);
          expect(executeOrderArgument[1].CreatedByUserId).to.equal(6);
          expect(executeOrderArgument[1].totalAmount).to.equal(4000);
          expect(executeOrderArgument[1].currency).to.equal('USD');
          expect(executeOrderArgument[1].paymentMethod.token).to.equal('tok_123456781234567812345678');
          await utils.waitForCondition(() => emailSendMessageSpy.callCount === 2);
          expect(emailSendMessageSpy.callCount).to.equal(2);
          assert.calledWithMatch(
            emailSendMessageSpy,
            user1.email,
            'New financial contributor to January meetup: incognito ($40.00)',
          );
          assert.calledWithMatch(
            emailSendMessageSpy,
            user2.email,
            'New financial contributor to January meetup: incognito ($40.00)',
          );
        });
      });
    });
  });
});

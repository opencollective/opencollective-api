import * as chai from 'chai';
import gqlV1 from 'fake-tag';
import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';

import ActivityTypes from '../../../../server/constants/activities';
import roles from '../../../../server/constants/roles';
import * as CacheLib from '../../../../server/lib/cache';
import models from '../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeOrder,
  fakeProject,
  fakeUser,
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

let host, user1, user2, user3, collective1;
let sandbox;

const { expect } = chai;

describe('server/graphql/v1/mutation', () => {
  /* SETUP
    collective1: 2 events
      event1: 1 free ticket, 1 paid ticket
  */

  before(() => {
    sandbox = createSandbox();
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
      username: 'stripeAccount',
      CollectiveId: host.collective.id,
    });
  });

  beforeEach('create an event collective', async () => {
    await models.Collective.create(
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
    const createCollectiveMutation = gqlV1 /* GraphQL */ `
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

      it('creates an event, uses the currency of parent collective and inherit fees', async () => {
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
        expect(createdEvent.hostFeePercent).to.equal(10);
        expect(createdEvent.isActive).to.be.true;
        event.id = createdEvent.id;

        // Make sure the creator of the event has been added as an ADMIN
        const members = await models.Member.findAll({
          where: { CollectiveId: event.id },
          order: [['MemberCollectiveId', 'ASC']],
        });
        expect(createdEvent.currency).to.equal(createdEvent.parentCollective.currency);
        expect(members).to.have.length(1);
        expect(members[0].role).to.equal(roles.HOST);
        expect(members[0].MemberCollectiveId).to.equal(collective1.HostCollectiveId);
        const updateQuery = gqlV1 /* GraphQL */ `
          mutation EditCollective($collective: CollectiveInputType!) {
            editCollective(collective: $collective) {
              id
              slug
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
      });
    });
  });

  describe('editCollective tests', () => {
    describe('archives a collective', () => {
      const archiveCollectiveMutation = gqlV1 /* GraphQL */ `
        mutation ArchiveCollective($id: Int!) {
          archiveCollective(id: $id) {
            id
            isArchived
          }
        }
      `;
      const unarchiveCollectiveMutation = gqlV1 /* GraphQL */ `
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

      it('creates a COLLECTIVE_ARCHIVED activity without sending notifications', async () => {
        const admin = await fakeUser();
        const hostCollective = await fakeActiveHost();
        const collective = await fakeCollective({ admin, HostCollectiveId: hostCollective.id });

        const response = await utils.graphqlQuery(archiveCollectiveMutation, { id: collective.id }, admin);
        expect(response.errors).to.not.exist;
        expect(response.data.archiveCollective.isArchived).to.be.true;

        const activity = await models.Activity.findOne({
          where: { type: ActivityTypes.COLLECTIVE_ARCHIVED, CollectiveId: collective.id },
        });
        expect(activity).to.exist;
        expect(activity.HostCollectiveId).to.equal(hostCollective.id);
        expect(activity.data.notify).to.be.false;
      });

      it('should mark all unprocessed expenses as canceled', async () => {
        // Setup test data
        const admin = await fakeUser();
        const collective = await fakeCollective({ admin });
        const project = await fakeProject({ admin, ParentCollectiveId: collective.id });
        const projectPaidExpense = await fakeExpense({ status: 'PAID', CollectiveId: project.id });
        const projectApprovedExpense = await fakeExpense({ status: 'APPROVED', CollectiveId: project.id });
        const randomPendingExpense = await fakeExpense({ status: 'PENDING' });
        const parentPendingExpense = await fakeExpense({ status: 'PENDING', CollectiveId: collective.id });
        const allExpenses = [projectPaidExpense, projectApprovedExpense, randomPendingExpense, parentPendingExpense];

        // Call mutation
        const response = await utils.graphqlQuery(archiveCollectiveMutation, { id: collective.id }, admin);
        response.errors && console.error(response.errors[0]);
        expect(response.errors).to.not.exist;
        expect(response.data.archiveCollective.isArchived).to.be.true;

        // Check DB entries
        await project.reload();
        await collective.reload();
        await Promise.all(allExpenses.map(e => e.reload()));

        // -- Accounts
        expect(collective.isActive).to.be.false;
        expect(collective.HostCollectiveId).to.be.null;
        expect(collective.deactivatedAt).to.be.a('date');
        expect(project.isActive).to.be.false;
        expect(project.HostCollectiveId).to.be.null;
        expect(project.deactivatedAt).to.be.a('date');

        // -- Expenses
        expect(projectPaidExpense.status).to.equal('PAID'); // No change for paid expenses
        expect(randomPendingExpense.status).to.equal('PENDING'); // No change for expenses not related to the archived collective

        expect(projectApprovedExpense.status).to.equal('CANCELED');
        expect(projectApprovedExpense.data.cancelledWhileArchivedFromCollective).to.be.true;
        expect(projectApprovedExpense.data.previousStatus).to.equal('APPROVED');

        expect(parentPendingExpense.status).to.equal('CANCELED');
        expect(parentPendingExpense.data.cancelledWhileArchivedFromCollective).to.be.true;
        expect(parentPendingExpense.data.previousStatus).to.equal('PENDING');
      });
    });

    describe('sensitive settings guards', () => {
      const editCollectiveMutation = gqlV1 /* GraphQL */ `
        mutation EditCollective($collective: CollectiveInputType!) {
          editCollective(collective: $collective) {
            id
            settings
            tags
          }
        }
      `;

      const editSettingsMutationV2 = `
        mutation EditAccountSetting($account: AccountReferenceInput!, $key: AccountSettingsKey!, $value: JSON!) {
          editAccountSetting(account: $account, key: $key, value: $value) {
            id
            settings
          }
        }
      `;

      it('rejects payoutsTwoFactorAuth changes', async () => {
        const admin = await fakeUser();
        const testHost = await fakeActiveHost({
          admin,
          settings: {
            payoutsTwoFactorAuth: { enabled: true, rollingLimit: 10_000_00 },
          },
        });

        const v2Result = await utils.graphqlQueryV2(
          editSettingsMutationV2,
          {
            account: { legacyId: testHost.id },
            key: 'payoutsTwoFactorAuth',
            value: { enabled: true, rollingLimit: 999_999_00 },
          },
          admin,
        );
        expect(v2Result.errors).to.exist;
        expect(v2Result.errors[0].message).to.match(/two factor/i);

        await testHost.reload();
        const v1Result = await utils.graphqlQuery(
          editCollectiveMutation,
          {
            collective: {
              id: testHost.id,
              settings: {
                ...testHost.settings,
                payoutsTwoFactorAuth: { enabled: true, rollingLimit: 999_999_00 },
              },
            },
          },
          admin,
        );

        expect(v1Result.errors).to.exist;
        expect(v1Result.errors[0].message).to.match(/payoutsTwoFactorAuth.*cannot be edited via GraphQL v1/i);
        await testHost.reload();
        expect(testHost.settings.payoutsTwoFactorAuth.rollingLimit).to.eq(10_000_00);
      });

      it('rejects payoutsTwoFactorAuth removal', async () => {
        const admin = await fakeUser();
        const testHost = await fakeActiveHost({
          admin,
          settings: {
            payoutsTwoFactorAuth: { enabled: true, rollingLimit: 10_000_00 },
          },
        });

        // Can't remove
        const resultRemove = await utils.graphqlQuery(
          editCollectiveMutation,
          { collective: { id: testHost.id, settings: {} } },
          admin,
        );
        expect(resultRemove.errors).to.exist;
        expect(resultRemove.errors[0].message).to.match(/payoutsTwoFactorAuth.*cannot be edited via GraphQL v1/i);

        // Can't nullify
        const resultNull = await utils.graphqlQuery(
          editCollectiveMutation,
          { collective: { id: testHost.id, settings: null } },
          admin,
        );
        expect(resultNull.errors).to.exist;
        expect(resultNull.errors[0].message).to.match(/payoutsTwoFactorAuth.*cannot be edited via GraphQL v1/i);

        await testHost.reload();
        expect(testHost.settings.payoutsTwoFactorAuth.rollingLimit).to.eq(10_000_00);
      });

      it('still allows unrelated settings edits', async () => {
        const admin = await fakeUser();
        const collective = await fakeCollective({
          admin,
          tags: ['old'],
          settings: { payoutsTwoFactorAuth: { enabled: true, rollingLimit: 10_000_00 } },
        });

        const result = await utils.graphqlQuery(
          editCollectiveMutation,
          {
            collective: {
              id: collective.id,
              tags: ['new'],
              settings: {
                tos: 'https://example.com/tos',
                payoutsTwoFactorAuth: { enabled: true, rollingLimit: 10_000_00 },
              },
            },
          },
          admin,
        );

        expect(result.errors).to.not.exist;
        expect(result.data.editCollective.tags).to.deep.eq(['new']);
        expect(result.data.editCollective.settings.tos).to.eq('https://example.com/tos');
        expect(result.data.editCollective.settings.payoutsTwoFactorAuth.rollingLimit).to.eq(10_000_00);
      });
    });
  });
});

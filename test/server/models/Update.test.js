import { expect } from 'chai';
import { flatten, reduce, times } from 'lodash';

import models, { Op } from '../../../server/models';
import { randEmail } from '../../stores';
import { fakeCollective, fakeMember, fakeOrganization, fakeUpdate, fakeUser } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

const addRandomMemberUsers = (collective, count, role) => {
  return Promise.all(
    times(count, async () => {
      const user = await fakeUser();
      await collective.addUserWithRole(user, role);
      return user;
    }),
  );
};

const expectAllEmailsFrom = (usersList, receivedEmails) => {
  return usersList.forEach(user => expect(receivedEmails).to.include(user.email));
};

describe('server/models/Update', () => {
  const dateOffset = 24 * 60 * 60 * 1000;
  const today = new Date().setUTCHours(0, 0, 0, 0);
  const yesterday = new Date(today - 1).setUTCDate(0, 0, 0, 0);
  const tomorrow = new Date(today + dateOffset);

  let user, collective;
  before(() => utils.resetTestDB());
  before('create a user', () =>
    models.User.createUserWithCollective({
      name: 'Xavier',
      email: randEmail(),
    }).then(u => (user = u)),
  );
  before('create a collective', () => models.Collective.create({ name: 'Webpack' }).then(c => (collective = c)));

  before('create updates', async () => {
    const commonAttributes = { CreatedByUserId: user.id, FromCollectiveId: collective.id, CollectiveId: collective.id };
    await Promise.all([
      models.Update.create({
        ...commonAttributes,
        id: 1,
        title: 'update 1 - yesterday',
        isPrivate: true,
        makePublicOn: yesterday,
      }),
      models.Update.create({
        ...commonAttributes,
        id: 2,
        title: 'update 2 - today',
        isPrivate: true,
        makePublicOn: today,
      }),
      models.Update.create({
        ...commonAttributes,
        id: 3,
        title: 'update 3 - tomorrow',
        isPrivate: true,
        makePublicOn: tomorrow,
      }),
      models.Update.create({
        ...commonAttributes,
        id: 4,
        title: 'update 4',
        isPrivate: true,
        makePublicOn: null,
      }),
      models.Update.create({
        ...commonAttributes,
        id: 5,
        title: 'unique-slug',
        isPrivate: false,
        makePublicOn: null,
      }),
    ]);
  });

  before('run makeUpdatesPublic', async () => {
    await models.Update.makeUpdatesPublic();
  });

  describe('private update must be public when', () => {
    it('update.makePublicOn < today', async () => {
      const update = await models.Update.findByPk(1);
      expect(update.dataValues.isPrivate).to.equal(false);
    });
    it('update.makePublicOn = today', async () => {
      const update = await models.Update.findByPk(2);
      expect(update.dataValues.isPrivate).to.equal(false);
    });
  });

  describe('private update must not be public when', () => {
    it('update.makePublicOn > today', async () => {
      const update = await models.Update.findByPk(3);
      expect(update.dataValues.isPrivate).to.equal(true);
    });

    it('update.makePublicOn is null', async () => {
      const update = await models.Update.findByPk(4);
      expect(update.dataValues.isPrivate).to.equal(true);
    });
  });

  describe('delete update', () => {
    it('frees up current slug when deleted', async () => {
      const uniqueSlug = 'unique-slug';
      const update = await models.Update.findOne({ where: { slug: uniqueSlug } });
      expect(update.slug).to.equal('unique-slug');
      await update.destroy();
      // free up slug after deletion
      expect(uniqueSlug).to.not.be.equal(update.slug);
      expect(/-\d+$/.test(update.slug)).to.be.true;
    });
  });

  describe('Update audience', () => {
    let collective,
      parentCollective,
      collectiveAdmins,
      parentCollectiveAdmins,
      parentCollectiveBackers,
      parentCollectiveFollowers,
      individualBackersUsers,
      backerOrganizations,
      collectiveFollowers,
      expectedPublicTotal,
      expectedPrivateTotal;

    const adminsOfMemberOrganizations = {};
    const countAdminsOfMemberOrganizations = () => {
      return reduce(adminsOfMemberOrganizations, (result, users) => result + users.length, 0);
    };
    const getOrganizationAdminUsers = () => {
      return flatten(reduce(adminsOfMemberOrganizations, (usersList, users) => [...usersList, ...users], []));
    };

    before(async () => {
      await utils.resetTestDB();
      parentCollective = await fakeCollective();
      collective = await fakeCollective({ ParentCollectiveId: parentCollective.id });
      collective.parentCollective = parentCollective;

      // Create backer organizations
      backerOrganizations = await Promise.all(times(4, fakeOrganization));

      // Add individual members
      parentCollectiveAdmins = await addRandomMemberUsers(parentCollective, 5, 'ADMIN');
      collectiveAdmins = await addRandomMemberUsers(collective, 2, 'ADMIN');
      individualBackersUsers = await addRandomMemberUsers(collective, 5, 'BACKER');
      collectiveFollowers = await addRandomMemberUsers(collective, 5, 'FOLLOWER');

      // Initialize the backer organizations
      for (const organization of backerOrganizations) {
        // Add some admins to the organizations
        adminsOfMemberOrganizations[organization.id] = await addRandomMemberUsers(organization, 3, 'ADMIN');
        // Add org as a backer of collective
        await fakeMember({ MemberCollectiveId: organization.id, CollectiveId: collective.id, role: 'BACKER' });
      }

      // Compute expected totals
      expectedPrivateTotal =
        collectiveAdmins.length +
        parentCollectiveAdmins.length +
        individualBackersUsers.length +
        countAdminsOfMemberOrganizations();

      expectedPublicTotal = expectedPrivateTotal + collectiveFollowers.length;

      // Pollute the DB with some random data to make sure it doesn't interfere
      parentCollectiveBackers = await addRandomMemberUsers(parentCollective, 7, 'BACKER');
      parentCollectiveFollowers = await addRandomMemberUsers(parentCollective, 5, 'FOLLOWER');
      await Promise.all(times(15, fakeMember)); // random members on different collectives
      // Add some admins as BACKER (to test grouping)
      await collective.addUserWithRole(collectiveAdmins[0], 'BACKER');
      await collective.addUserWithRole(parentCollectiveAdmins[0], 'BACKER');

      // Add some deleted members
      await Promise.all(
        [parentCollective, collective, ...backerOrganizations].map(async account => {
          const users = await addRandomMemberUsers(account, 3, 'BACKER');
          const usersCollectiveIds = users.map(u => u.CollectiveId);
          await models.Member.destroy({ where: { MemberCollectiveId: { [Op.in]: usersCollectiveIds } } });
        }),
      );
    });

    describe('getUsersIdsToNotify', () => {
      it('returns an empty array when the collective has no member', async () => {
        const emptyCollective = await fakeCollective();
        const update = await fakeUpdate({ CollectiveId: emptyCollective.id });
        const usersIdsToNotify = await update.getUsersIdsToNotify();
        expect(usersIdsToNotify.length).to.eq(0);
      });

      it('returns an empty array when the audience in NO_ONE', async () => {
        const update = await fakeUpdate({ CollectiveId: collective.id, notificationAudience: 'NO_ONE' });
        const usersIdsToNotify = await update.getUsersIdsToNotify();
        expect(usersIdsToNotify.length).to.eq(0);
      });

      it('notifies only the admin if there is only one', async () => {
        const collectiveWithOneAdmin = await fakeCollective();
        await addRandomMemberUsers(collectiveWithOneAdmin, 1, 'ADMIN');
        const update = await fakeUpdate({ CollectiveId: collectiveWithOneAdmin.id });
        const usersIdsToNotify = await update.getUsersIdsToNotify();
        expect(usersIdsToNotify.length).to.eq(1);
      });

      it('Notifies everyone when the update is public', async () => {
        const update = await fakeUpdate({ CollectiveId: collective.id, isPrivate: false });
        const usersIdsToNotify = await update.getUsersIdsToNotify();
        const usersToNotify = await models.User.findAll({ where: { id: usersIdsToNotify } });
        const receivedEmails = usersToNotify.map(u => u.email);

        expectAllEmailsFrom(parentCollectiveAdmins, receivedEmails);
        expectAllEmailsFrom(collectiveAdmins, receivedEmails);
        expectAllEmailsFrom(individualBackersUsers, receivedEmails);
        expectAllEmailsFrom(collectiveFollowers, receivedEmails);
        expectAllEmailsFrom(getOrganizationAdminUsers(), receivedEmails);
        expect(usersIdsToNotify.length).to.eq(expectedPublicTotal);
      });

      it('Notifies only those allowed to see when private', async () => {
        const update = await fakeUpdate({ CollectiveId: collective.id, isPrivate: true });
        const usersIdsToNotify = await update.getUsersIdsToNotify();
        const usersToNotify = await models.User.findAll({ where: { id: usersIdsToNotify } });
        const receivedEmails = usersToNotify.map(u => u.email);

        expectAllEmailsFrom(parentCollectiveAdmins, receivedEmails);
        expectAllEmailsFrom(collectiveAdmins, receivedEmails);
        expectAllEmailsFrom(individualBackersUsers, receivedEmails);
        expectAllEmailsFrom(getOrganizationAdminUsers(), receivedEmails);
        expect(usersIdsToNotify.length).to.eq(expectedPrivateTotal);
      });

      it('Notifies child collective users when parent collective public update is made', async () => {
        const update = await fakeUpdate({ CollectiveId: parentCollective.id, isPrivate: false });
        const usersIdsToNotify = await update.getUsersIdsToNotify();
        const usersToNotify = await models.User.findAll({ where: { id: usersIdsToNotify } });
        const receivedEmails = usersToNotify.map(u => u.email);

        expectAllEmailsFrom(parentCollectiveAdmins, receivedEmails);
        expectAllEmailsFrom(parentCollectiveBackers, receivedEmails);
        expectAllEmailsFrom(parentCollectiveFollowers, receivedEmails);
        expectAllEmailsFrom(collectiveAdmins, receivedEmails);
        expectAllEmailsFrom(individualBackersUsers, receivedEmails);
        expectAllEmailsFrom(getOrganizationAdminUsers(), receivedEmails);

        expect(usersIdsToNotify.length).to.eq(
          parentCollectiveAdmins.length +
            parentCollectiveBackers.length +
            parentCollectiveFollowers.length +
            collectiveAdmins.length +
            collectiveFollowers.length +
            individualBackersUsers.length +
            countAdminsOfMemberOrganizations(),
        );
      });

      it('Notifies child collective users when parent collective private update is made', async () => {
        const update = await fakeUpdate({ CollectiveId: parentCollective.id, isPrivate: true });
        const usersIdsToNotify = await update.getUsersIdsToNotify();
        const usersToNotify = await models.User.findAll({ where: { id: usersIdsToNotify } });
        const receivedEmails = usersToNotify.map(u => u.email);

        expectAllEmailsFrom(parentCollectiveAdmins, receivedEmails);
        expectAllEmailsFrom(parentCollectiveBackers, receivedEmails);
        expectAllEmailsFrom(collectiveAdmins, receivedEmails);
        expectAllEmailsFrom(individualBackersUsers, receivedEmails);
        expectAllEmailsFrom(getOrganizationAdminUsers(), receivedEmails);

        expect(usersIdsToNotify.length).to.eq(
          parentCollectiveAdmins.length +
            parentCollectiveBackers.length +
            collectiveAdmins.length +
            individualBackersUsers.length +
            countAdminsOfMemberOrganizations(),
        );
      });
    });

    describe('countUsersToNotify', () => {
      it('returns 0 everywhere array when the collective has no member', async () => {
        const emptyCollective = await fakeCollective();
        const update = await fakeUpdate({ CollectiveId: emptyCollective.id });
        const count = await update.countUsersToNotify();
        expect(count).to.eq(0);
      });

      it('returns 0 when the audience is NO_ONE', async () => {
        const update = await fakeUpdate({ CollectiveId: collective.id, notificationAudience: 'NO_ONE' });
        const count = await update.countUsersToNotify();
        expect(count).to.eq(0);
      });

      it('When the update is public', async () => {
        const update = await fakeUpdate({ CollectiveId: collective.id, isPrivate: false });
        const count = await update.countUsersToNotify();
        expect(count).to.eq(expectedPublicTotal);
      });

      it('When the update is private', async () => {
        const update = await fakeUpdate({ CollectiveId: collective.id, isPrivate: true });
        const count = await update.countUsersToNotify();
        expect(count).to.eq(expectedPrivateTotal);
      });
    });

    describe('getAudienceMembersStats', () => {
      it('returns an empty object when the collective has no member', async () => {
        const emptyCollective = await fakeCollective({ HostCollectiveId: null });
        const update = await fakeUpdate({ CollectiveId: emptyCollective.id });
        const stats = await update.getAudienceMembersStats();
        expect(stats).to.be.empty;
      });

      it('When the update is public', async () => {
        const update = await fakeUpdate({ CollectiveId: collective.id, isPrivate: false });
        const stats = await update.getAudienceMembersStats();
        expect(stats.ORGANIZATION).to.eq(backerOrganizations.length);
        expect(stats.CORE_CONTRIBUTOR).to.eq(parentCollectiveAdmins.length + collectiveAdmins.length);
        expect(stats.USER).to.eq(individualBackersUsers.length + collectiveFollowers.length);
      });

      it('When the update is private', async () => {
        const update = await fakeUpdate({ CollectiveId: collective.id, isPrivate: true });
        const stats = await update.getAudienceMembersStats();
        expect(stats.ORGANIZATION).to.eq(backerOrganizations.length);
        expect(stats.CORE_CONTRIBUTOR).to.eq(parentCollectiveAdmins.length + collectiveAdmins.length);
        expect(stats.USER).to.eq(individualBackersUsers.length);
      });

      it('When parent collective public update is made', async () => {
        const update = await fakeUpdate({ CollectiveId: parentCollective.id, isPrivate: false });
        const stats = await update.getAudienceMembersStats();
        expect(stats.ORGANIZATION).to.eq(backerOrganizations.length);
        expect(stats.CORE_CONTRIBUTOR).to.eq(parentCollectiveAdmins.length + collectiveAdmins.length);
        expect(stats.USER).to.eq(
          individualBackersUsers.length +
            parentCollectiveBackers.length +
            collectiveFollowers.length +
            parentCollectiveFollowers.length,
        );
      });

      it('When parent collective private update is made', async () => {
        const update = await fakeUpdate({ CollectiveId: parentCollective.id, isPrivate: true });
        const stats = await update.getAudienceMembersStats();
        expect(stats.ORGANIZATION).to.eq(backerOrganizations.length);
        expect(stats.CORE_CONTRIBUTOR).to.eq(parentCollectiveAdmins.length + collectiveAdmins.length);
        expect(stats.USER).to.eq(individualBackersUsers.length + parentCollectiveBackers.length);
      });
    });
  });
});

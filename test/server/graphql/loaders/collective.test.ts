import { expect } from 'chai';
import moment from 'moment';

import { CollectiveType } from '../../../../server/constants/collectives';
import ExpenseStatuses from '../../../../server/constants/expense-status';
import OrderStatuses from '../../../../server/constants/order-status';
import MemberRoles from '../../../../server/constants/roles';
import { TransactionKind } from '../../../../server/constants/transaction-kind';
import CollectiveLoaders from '../../../../server/graphql/loaders/collective';
import { sequelize } from '../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeIncognitoProfile,
  fakeMember,
  fakeOrder,
  fakeOrganization,
  fakeTransaction,
  fakeUser,
  fakeVendor,
  multiple,
} from '../../../test-helpers/fake-data';
import { makeRequest, resetTestDB } from '../../../utils';

describe('server/graphql/loaders/collective', () => {
  before(async () => {
    await resetTestDB();
  });

  describe('isApproved', () => {
    it('is true for an account hosted and approved by a fiscal host', async () => {
      const collective = await fakeCollective();
      expect(await CollectiveLoaders.isApproved().load(collective.id)).to.be.true;
    });

    it('is false for an account that is still waiting for its host to approve it', async () => {
      const host = await fakeActiveHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id, isActive: false, approvedAt: null });
      expect(await CollectiveLoaders.isApproved().load(collective.id)).to.be.false;
    });

    it('is true for a self-hosted account', async () => {
      const host = await fakeActiveHost();
      await host.update({ HostCollectiveId: host.id });
      expect(await CollectiveLoaders.isApproved().load(host.id)).to.be.true;
    });

    it('defers to the parent for projects and events', async () => {
      const parent = await fakeCollective();
      const project = await fakeCollective({
        type: CollectiveType.PROJECT,
        ParentCollectiveId: parent.id,
        HostCollectiveId: null,
      });
      const event = await fakeCollective({
        type: CollectiveType.EVENT,
        ParentCollectiveId: parent.id,
        HostCollectiveId: null,
      });

      expect(await CollectiveLoaders.isApproved().load(project.id)).to.be.true;
      expect(await CollectiveLoaders.isApproved().load(event.id)).to.be.true;
    });

    it('is false for a child whose parent is not approved', async () => {
      const host = await fakeActiveHost();
      const parent = await fakeCollective({ HostCollectiveId: host.id, isActive: false, approvedAt: null });
      const project = await fakeCollective({
        type: CollectiveType.PROJECT,
        ParentCollectiveId: parent.id,
        HostCollectiveId: null,
      });

      expect(await CollectiveLoaders.isApproved().load(project.id)).to.be.false;
    });

    it('is false for an unknown account', async () => {
      expect(await CollectiveLoaders.isApproved().load(123456789)).to.be.false;
    });
  });

  it('does not expose private profile information through a legacy follower membership', async () => {
    const user = await fakeUser();
    const collectiveAdmin = await fakeUser();
    const hostAdmin = await fakeUser();
    const collective = await fakeCollective({ admin: collectiveAdmin });
    await collective.host.addUserWithRole(hostAdmin, MemberRoles.ADMIN);

    const member = await fakeMember({
      CollectiveId: collective.id,
      MemberCollectiveId: user.CollectiveId,
      role: MemberRoles.BACKER,
    });
    // Simulate a soft-deleted follower membership left behind by the retirement migration.
    await sequelize.query(`UPDATE "Members" SET role = 'FOLLOWER', "deletedAt" = NOW() WHERE id = :id`, {
      replacements: { id: member.id },
    });

    for (const remoteUser of [collectiveAdmin, hostAdmin]) {
      expect(await CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser }).load(user.CollectiveId)).to.be.false;
      expect(await CollectiveLoaders.canSeePrivateLocation({ remoteUser }).load(user.CollectiveId)).to.be.false;
    }
  });

  describe('private info membership approval', () => {
    for (const role of Object.values(MemberRoles)) {
      for (const approved of [false, true]) {
        it(`checks ${role} memberships with approved=${approved} consistently for profile info and location`, async () => {
          const remoteUser = await fakeUser();
          const host = await fakeActiveHost({ admin: remoteUser });
          const collective = await fakeCollective({
            HostCollectiveId: host.id,
            approvedAt: approved ? new Date() : null,
          });
          const member = await fakeUser();
          await fakeMember({ CollectiveId: collective.id, MemberCollectiveId: member.CollectiveId, role });

          const expected = role === MemberRoles.HOST ? approved : role !== MemberRoles.CONNECTED_COLLECTIVE;
          expect(await CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser }).load(member.CollectiveId)).to.eq(
            expected,
          );
          expect(await CollectiveLoaders.canSeePrivateLocation({ remoteUser }).load(member.CollectiveId)).to.eq(
            expected,
          );
        });
      }
    }

    for (const approved of [false, true]) {
      it(`does not grant private info access for an unknown membership role with approved=${approved}`, async () => {
        const remoteUser = await fakeUser();
        const host = await fakeActiveHost({ admin: remoteUser });
        const collective = await fakeCollective({
          HostCollectiveId: host.id,
          approvedAt: approved ? new Date() : null,
        });
        const member = await fakeUser();
        const membership = await fakeMember({
          CollectiveId: collective.id,
          MemberCollectiveId: member.CollectiveId,
          role: MemberRoles.BACKER,
        });
        // Simulate a future role without granting it private-info access implicitly.
        await sequelize.query(`UPDATE "Members" SET role = 'FUTURE_ROLE' WHERE id = :id`, {
          replacements: { id: membership.id },
        });

        expect(await CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser }).load(member.CollectiveId)).to.be.false;
        expect(await CollectiveLoaders.canSeePrivateLocation({ remoteUser }).load(member.CollectiveId)).to.be.false;
      });
    }

    it('keeps ordinary memberships visible to admins of an independent collective', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ HostCollectiveId: null, approvedAt: null, admin: remoteUser });
      const member = await fakeUser();
      await collective.addUserWithRole(member, MemberRoles.ADMIN);

      expect(await CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser }).load(member.CollectiveId)).to.be.true;
      expect(await CollectiveLoaders.canSeePrivateLocation({ remoteUser }).load(member.CollectiveId)).to.be.false;
    });
  });

  describe('canSeePrivateProfileInfo', () => {
    describe('User info', () => {
      let userWithPrivateInfo, randomUser, collectiveAdmin, hostAdmin;

      before(async () => {
        userWithPrivateInfo = await fakeUser();
        randomUser = await fakeUser();
        collectiveAdmin = await fakeUser();
        hostAdmin = await fakeUser();

        const collective = await fakeCollective();
        await collective.addUserWithRole(userWithPrivateInfo, 'BACKER');
        await collective.addUserWithRole(collectiveAdmin, 'ADMIN');
        await collective.host.addUserWithRole(hostAdmin, 'ADMIN');
      });

      it('Cannot see infos as unauthenticated', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: null });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Cannot see infos as a random user', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: randomUser });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Can see infos if self', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: userWithPrivateInfo });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Can see infos if collective admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: collectiveAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Can see infos if host admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: hostAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });
    });

    describe('Incognito user info', () => {
      let userWithPrivateInfo, incognitoProfile, randomUser, collectiveAdmin, hostAdmin;

      before(async () => {
        userWithPrivateInfo = await fakeUser();
        randomUser = await fakeUser();
        collectiveAdmin = await fakeUser();
        hostAdmin = await fakeUser();
        incognitoProfile = await fakeCollective({
          type: CollectiveType.USER,
          isIncognito: true,
          name: 'Incognito',
          HostCollectiveId: null,
          CreatedByUserId: userWithPrivateInfo.id,
        });
        const collective = await fakeCollective();
        await collective.addUserWithRole(collectiveAdmin, 'ADMIN');
        await collective.host.addUserWithRole(hostAdmin, 'ADMIN');

        // Here we're making the incognito profile a backer of the collective (rather than
        // using `userWithPrivateInfo` directly)
        await fakeMember({
          role: MemberRoles.BACKER,
          MemberCollectiveId: incognitoProfile.id,
          CollectiveId: collective.id,
        });
        await incognitoProfile.addUserWithRole(userWithPrivateInfo, 'ADMIN');
      });

      it('Cannot see infos as unauthenticated', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: null });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Cannot see infos as a random user', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: randomUser });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Can see infos if self', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: userWithPrivateInfo });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Cannot see infos if collective admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: collectiveAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Can see infos if host admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: hostAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Cannot see location if collective admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateLocation({ remoteUser: collectiveAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.false;
      });

      it('Can see location if host admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateLocation({ remoteUser: hostAdmin });
        const result = await loader.load(userWithPrivateInfo.CollectiveId);
        expect(result).to.be.true;
      });

      it('Cannot see incognito profile infos as a collective admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: collectiveAdmin });
        expect(await loader.load(incognitoProfile.id)).to.be.false;
      });

      it('Can see incognito profile infos as the profile owner', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: userWithPrivateInfo });
        expect(await loader.load(incognitoProfile.id)).to.be.true;
      });

      it('Can see incognito profile infos as a host admin', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: hostAdmin });
        expect(await loader.load(incognitoProfile.id)).to.be.true;
      });

      it('Cannot see incognito profile infos as a random user', async () => {
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: randomUser });
        expect(await loader.load(incognitoProfile.id)).to.be.false;
      });

      it('keeps a mixed batch private except for an ordinary collective member', async () => {
        const regularMember = await fakeUser();
        const collective = await fakeCollective({ admin: collectiveAdmin, HostCollectiveId: null });
        await collective.addUserWithRole(regularMember, MemberRoles.BACKER);
        const loader = CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser: collectiveAdmin });
        expect(
          await loader.loadMany([userWithPrivateInfo.CollectiveId, incognitoProfile.id, regularMember.CollectiveId]),
        ).to.deep.equal([false, false, true]);
      });

      it('preserves incognito access for an admin of a self-hosted collective', async () => {
        const selfHosted = await fakeActiveHost({ admin: collectiveAdmin });
        await fakeMember({
          CollectiveId: selfHosted.id,
          MemberCollectiveId: incognitoProfile.id,
          role: MemberRoles.BACKER,
        });
        for (const factory of [CollectiveLoaders.canSeePrivateProfileInfo, CollectiveLoaders.canSeePrivateLocation]) {
          const loader = factory({ remoteUser: collectiveAdmin });
          expect(await loader.loadMany([userWithPrivateInfo.CollectiveId, incognitoProfile.id])).to.deep.equal([
            true,
            true,
          ]);
        }
      });
    });

    describe('Processing orders', () => {
      let hostAdmin, host, collective, target;

      beforeEach(async () => {
        hostAdmin = await fakeUser();
        host = await fakeActiveHost({ admin: hostAdmin });
        collective = await fakeCollective({ HostCollectiveId: host.id });
        target = await fakeUser();
      });

      const canSeeProfileInfo = remoteUser =>
        CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser }).load(target.collective.id);

      it('grants access for a PROCESSING order created by the target', async () => {
        await fakeOrder({
          CreatedByUserId: target.id,
          FromCollectiveId: target.collective.id,
          CollectiveId: collective.id,
          status: OrderStatuses.PROCESSING,
        });
        expect(await canSeeProfileInfo(hostAdmin)).to.be.true;
      });

      it('grants access when the target created the order for another account', async () => {
        const organization = await fakeOrganization({ admin: target });
        await fakeOrder({
          FromCollectiveId: organization.id,
          CreatedByUserId: target.id,
          CollectiveId: collective.id,
          status: OrderStatuses.PROCESSING,
        });
        expect(await canSeeProfileInfo(hostAdmin)).to.be.true;
      });

      it('does not grant access based on the order from-collective alone', async () => {
        const otherUser = await fakeUser();
        await fakeOrder({
          FromCollectiveId: target.collective.id,
          CreatedByUserId: otherUser.id,
          CollectiveId: collective.id,
          status: OrderStatuses.PROCESSING,
        });
        expect(await canSeeProfileInfo(hostAdmin)).to.be.false;
      });

      it('does not grant access for orders that are not PROCESSING', async () => {
        for (const status of [OrderStatuses.ACTIVE, OrderStatuses.DISPUTED, OrderStatuses.PENDING]) {
          await fakeOrder({
            FromCollectiveId: target.collective.id,
            CreatedByUserId: target.id,
            CollectiveId: collective.id,
            status,
          });
        }
        expect(await canSeeProfileInfo(hostAdmin)).to.be.false;
      });

      it('does not grant access when the collective is hosted by another host', async () => {
        const otherHost = await fakeActiveHost();
        const otherCollective = await fakeCollective({ HostCollectiveId: otherHost.id });
        await fakeOrder({
          CreatedByUserId: target.id,
          CollectiveId: otherCollective.id,
          status: OrderStatuses.PROCESSING,
        });
        expect(await canSeeProfileInfo(hostAdmin)).to.be.false;
      });

      it('does not grant access to collective admins', async () => {
        const collectiveAdmin = await fakeUser();
        await collective.addUserWithRole(collectiveAdmin, MemberRoles.ADMIN);
        await fakeOrder({
          FromCollectiveId: target.collective.id,
          CreatedByUserId: target.id,
          CollectiveId: collective.id,
          status: OrderStatuses.PROCESSING,
        });
        expect(await canSeeProfileInfo(collectiveAdmin)).to.be.false;
      });

      it('does not grant access to host accountants', async () => {
        const accountant = await fakeUser();
        await host.addUserWithRole(accountant, MemberRoles.ACCOUNTANT);
        await fakeOrder({
          FromCollectiveId: target.collective.id,
          CreatedByUserId: target.id,
          CollectiveId: collective.id,
          status: OrderStatuses.PROCESSING,
        });
        expect(await canSeeProfileInfo(accountant)).to.be.false;
      });

      it('does not grant access to random users', async () => {
        const randomUser = await fakeUser();
        await fakeOrder({
          FromCollectiveId: target.collective.id,
          CreatedByUserId: target.id,
          CollectiveId: collective.id,
          status: OrderStatuses.PROCESSING,
        });
        expect(await canSeeProfileInfo(randomUser)).to.be.false;
      });
    });

    describe('Expense payees', () => {
      let hostAdmin, host, collective, target;

      beforeEach(async () => {
        hostAdmin = await fakeUser();
        host = await fakeActiveHost({ admin: hostAdmin });
        collective = await fakeCollective({ HostCollectiveId: host.id });
        target = await fakeUser();
      });

      const canSeeProfileInfo = remoteUser =>
        CollectiveLoaders.canSeePrivateProfileInfo({ remoteUser }).load(target.collective.id);

      const canSeeLocation = remoteUser =>
        CollectiveLoaders.canSeePrivateLocation({ remoteUser }).load(target.collective.id);

      const fakeExpenseFor = (expenseData: Record<string, unknown> = {}) =>
        fakeExpense({
          HostCollectiveId: host.id,
          CollectiveId: collective.id,
          FromCollectiveId: target.collective.id,
          status: ExpenseStatuses.PAID,
          ...expenseData,
        });

      it('grants access for an expense paid by the host', async () => {
        await fakeExpenseFor();
        expect(await canSeeProfileInfo(hostAdmin)).to.be.true;
        expect(await canSeeLocation(hostAdmin)).to.be.true;
      });

      it('grants access when the collective is no longer hosted', async () => {
        const formerCollective = await fakeCollective({ HostCollectiveId: null });
        await fakeExpenseFor({ CollectiveId: formerCollective.id });
        expect(await canSeeProfileInfo(hostAdmin)).to.be.true;
        expect(await canSeeLocation(hostAdmin)).to.be.true;
      });

      it('grants access when the collective moved to another host', async () => {
        const otherHost = await fakeActiveHost();
        const movedCollective = await fakeCollective({ HostCollectiveId: otherHost.id });
        await fakeExpenseFor({ CollectiveId: movedCollective.id });
        expect(await canSeeProfileInfo(hostAdmin)).to.be.true;
        expect(await canSeeLocation(hostAdmin)).to.be.true;
      });

      for (const status of [ExpenseStatuses.PROCESSING, ExpenseStatuses.SCHEDULED_FOR_PAYMENT]) {
        it(`grants access for ${status} expenses`, async () => {
          await fakeExpenseFor({ status, HostCollectiveId: null });
          expect(await canSeeProfileInfo(hostAdmin)).to.be.true;
          expect(await canSeeLocation(hostAdmin)).to.be.true;
        });

        it(`ignores a stale host on ${status} expenses`, async () => {
          const previousAdmin = await fakeUser();
          const previousHost = await fakeActiveHost({ admin: previousAdmin });
          await fakeExpenseFor({ status, HostCollectiveId: previousHost.id });

          for (const loader of [CollectiveLoaders.canSeePrivateProfileInfo, CollectiveLoaders.canSeePrivateLocation]) {
            expect(await loader({ remoteUser: previousAdmin }).load(target.CollectiveId)).to.be.false;
            expect(await loader({ remoteUser: hostAdmin }).load(target.CollectiveId)).to.be.true;
          }
        });

        it(`does not grant access through an unapproved host for ${status} expenses`, async () => {
          await collective.update({ approvedAt: null });
          await fakeExpenseFor({ status, HostCollectiveId: null });
          expect(await canSeeProfileInfo(hostAdmin)).to.be.false;
          expect(await canSeeLocation(hostAdmin)).to.be.false;
        });

        it(`uses the approved parent host for ${status} expenses`, async () => {
          const child = await fakeCollective({
            type: CollectiveType.EVENT,
            HostCollectiveId: null,
            ParentCollectiveId: collective.id,
            approvedAt: null,
          });
          await fakeExpenseFor({ status, HostCollectiveId: null, CollectiveId: child.id });
          expect(await canSeeProfileInfo(hostAdmin)).to.be.true;
          expect(await canSeeLocation(hostAdmin)).to.be.true;
        });

        it(`does not use an unapproved parent host for ${status} expenses`, async () => {
          await collective.update({ approvedAt: null });
          const child = await fakeCollective({
            type: CollectiveType.EVENT,
            HostCollectiveId: null,
            ParentCollectiveId: collective.id,
            approvedAt: null,
          });
          await fakeExpenseFor({ status, HostCollectiveId: null, CollectiveId: child.id });
          expect(await canSeeProfileInfo(hostAdmin)).to.be.false;
          expect(await canSeeLocation(hostAdmin)).to.be.false;
        });
      }

      for (const type of [CollectiveType.ORGANIZATION, CollectiveType.COLLECTIVE, CollectiveType.VENDOR]) {
        for (const status of [
          ExpenseStatuses.PAID,
          ExpenseStatuses.PROCESSING,
          ExpenseStatuses.SCHEDULED_FOR_PAYMENT,
        ]) {
          it(`does not grant private info or location access to a ${type} payee for ${status}`, async () => {
            const payee =
              type === CollectiveType.VENDOR
                ? await fakeVendor({ ParentCollectiveId: host.id })
                : await fakeCollective({ type, HostCollectiveId: null });
            await fakeExpenseFor({ FromCollectiveId: payee.id, status });
            for (const loader of [
              CollectiveLoaders.canSeePrivateProfileInfo,
              CollectiveLoaders.canSeePrivateLocation,
            ]) {
              expect(await loader({ remoteUser: hostAdmin }).load(payee.id)).to.be.false;
            }
          });
        }
      }

      for (const status of [
        ExpenseStatuses.PENDING,
        ExpenseStatuses.APPROVED,
        ExpenseStatuses.REJECTED,
        ExpenseStatuses.ERROR,
        ExpenseStatuses.CANCELED,
      ]) {
        it(`does not grant access for ${status} expenses`, async () => {
          await fakeExpenseFor({ status });
          expect(await canSeeProfileInfo(hostAdmin)).to.be.false;
          expect(await canSeeLocation(hostAdmin)).to.be.false;
        });
      }

      it('does not grant access when the expense was paid by another host', async () => {
        const otherHost = await fakeActiveHost();
        await fakeExpenseFor({ HostCollectiveId: otherHost.id });
        expect(await canSeeProfileInfo(hostAdmin)).to.be.false;
        expect(await canSeeLocation(hostAdmin)).to.be.false;
      });

      it('does not grant access based on the expense submitter alone', async () => {
        const otherUser = await fakeUser();
        await fakeExpenseFor({ FromCollectiveId: otherUser.collective.id, UserId: target.id });
        expect(await canSeeProfileInfo(hostAdmin)).to.be.false;
        expect(await canSeeLocation(hostAdmin)).to.be.false;
      });

      it('grants access when the expense was paid to the target incognito profile', async () => {
        const incognitoProfile = await fakeIncognitoProfile(target);
        await fakeExpenseFor({ FromCollectiveId: incognitoProfile.id });
        expect(await canSeeProfileInfo(hostAdmin)).to.be.true;
        expect(await canSeeLocation(hostAdmin)).to.be.true;
      });

      it('keeps incognito payee access independent from the primary profile being in the same batch', async () => {
        const incognitoProfile = await fakeIncognitoProfile(target);
        await fakeExpenseFor({ FromCollectiveId: incognitoProfile.id });

        for (const factory of [CollectiveLoaders.canSeePrivateProfileInfo, CollectiveLoaders.canSeePrivateLocation]) {
          expect(await factory({ remoteUser: hostAdmin }).load(incognitoProfile.id)).to.be.true;
          expect(
            await factory({ remoteUser: hostAdmin }).loadMany([target.collective.id, incognitoProfile.id]),
          ).to.deep.equal([true, true]);
        }
      });

      it('does not grant access to collective admins', async () => {
        const collectiveAdmin = await fakeUser();
        await collective.addUserWithRole(collectiveAdmin, MemberRoles.ADMIN);
        await fakeExpenseFor();
        expect(await canSeeProfileInfo(collectiveAdmin)).to.be.false;
        expect(await canSeeLocation(collectiveAdmin)).to.be.false;
      });

      it('does not grant access to host accountants', async () => {
        const accountant = await fakeUser();
        await host.addUserWithRole(accountant, MemberRoles.ACCOUNTANT);
        await fakeExpenseFor();
        expect(await canSeeProfileInfo(accountant)).to.be.false;
        expect(await canSeeLocation(accountant)).to.be.false;
      });

      it('does not grant access to random users', async () => {
        const randomUser = await fakeUser();
        await fakeExpenseFor();
        expect(await canSeeProfileInfo(randomUser)).to.be.false;
        expect(await canSeeLocation(randomUser)).to.be.false;
      });
    });
  });

  describe('canSeePrivateLocation', () => {
    let userWithPrivateInfo, randomUser, collectiveAdmin, hostAdmin;

    before(async () => {
      userWithPrivateInfo = await fakeUser();
      randomUser = await fakeUser();
      collectiveAdmin = await fakeUser();
      hostAdmin = await fakeUser();

      const collective = await fakeCollective();
      await collective.addUserWithRole(userWithPrivateInfo, 'BACKER');
      await collective.addUserWithRole(collectiveAdmin, 'ADMIN');
      await collective.host.addUserWithRole(hostAdmin, 'ADMIN');
    });

    it('Cannot see infos as unauthenticated', async () => {
      const loader = CollectiveLoaders.canSeePrivateLocation({ remoteUser: null });
      const result = await loader.load(userWithPrivateInfo.CollectiveId);
      expect(result).to.be.false;
    });

    it('Cannot see infos as a random user', async () => {
      const loader = CollectiveLoaders.canSeePrivateLocation({ remoteUser: randomUser });
      const result = await loader.load(userWithPrivateInfo.CollectiveId);
      expect(result).to.be.false;
    });

    it('Can see infos if self', async () => {
      const loader = CollectiveLoaders.canSeePrivateLocation({ remoteUser: userWithPrivateInfo });
      const result = await loader.load(userWithPrivateInfo.CollectiveId);
      expect(result).to.be.true;
    });

    it('Cannot see infos if collective admin', async () => {
      const loader = CollectiveLoaders.canSeePrivateLocation({ remoteUser: collectiveAdmin });
      const result = await loader.load(userWithPrivateInfo.CollectiveId);
      expect(result).to.be.false;
    });

    it('Can see infos if host admin', async () => {
      const loader = CollectiveLoaders.canSeePrivateLocation({ remoteUser: hostAdmin });
      const result = await loader.load(userWithPrivateInfo.CollectiveId);
      expect(result).to.be.true;
    });
  });

  describe('canSeePrivateLocation with processing orders', () => {
    let hostAdmin, host, collective, target;

    beforeEach(async () => {
      hostAdmin = await fakeUser();
      host = await fakeActiveHost({ admin: hostAdmin });
      collective = await fakeCollective({ HostCollectiveId: host.id });
      target = await fakeUser();
    });

    const canSeeLocation = remoteUser =>
      CollectiveLoaders.canSeePrivateLocation({ remoteUser }).load(target.collective.id);

    it('grants access for a PROCESSING order created by the target', async () => {
      await fakeOrder({
        CreatedByUserId: target.id,
        FromCollectiveId: target.collective.id,
        CollectiveId: collective.id,
        status: OrderStatuses.PROCESSING,
      });
      expect(await canSeeLocation(hostAdmin)).to.be.true;
    });

    it('grants access when the target created the order for another account', async () => {
      const organization = await fakeOrganization({ admin: target });
      await fakeOrder({
        FromCollectiveId: organization.id,
        CreatedByUserId: target.id,
        CollectiveId: collective.id,
        status: OrderStatuses.PROCESSING,
      });
      expect(await canSeeLocation(hostAdmin)).to.be.true;
    });

    it('does not grant access based on the order from-collective alone', async () => {
      const otherUser = await fakeUser();
      await fakeOrder({
        FromCollectiveId: target.collective.id,
        CreatedByUserId: otherUser.id,
        CollectiveId: collective.id,
        status: OrderStatuses.PROCESSING,
      });
      expect(await canSeeLocation(hostAdmin)).to.be.false;
    });

    it('does not grant access for orders that are not PROCESSING', async () => {
      for (const status of [OrderStatuses.ACTIVE, OrderStatuses.DISPUTED, OrderStatuses.PENDING]) {
        await fakeOrder({
          FromCollectiveId: target.collective.id,
          CreatedByUserId: target.id,
          CollectiveId: collective.id,
          status,
        });
      }
      expect(await canSeeLocation(hostAdmin)).to.be.false;
    });

    it('does not grant access when the collective is hosted by another host', async () => {
      const otherHost = await fakeActiveHost();
      const otherCollective = await fakeCollective({ HostCollectiveId: otherHost.id });
      await fakeOrder({
        CreatedByUserId: target.id,
        CollectiveId: otherCollective.id,
        status: OrderStatuses.PROCESSING,
      });
      expect(await canSeeLocation(hostAdmin)).to.be.false;
    });

    it('does not grant access to collective admins', async () => {
      const collectiveAdmin = await fakeUser();
      await collective.addUserWithRole(collectiveAdmin, MemberRoles.ADMIN);
      await fakeOrder({
        FromCollectiveId: target.collective.id,
        CreatedByUserId: target.id,
        CollectiveId: collective.id,
        status: OrderStatuses.PROCESSING,
      });
      expect(await canSeeLocation(collectiveAdmin)).to.be.false;
    });

    it('does not grant access to host accountants', async () => {
      const accountant = await fakeUser();
      await host.addUserWithRole(accountant, MemberRoles.ACCOUNTANT);
      await fakeOrder({
        FromCollectiveId: target.collective.id,
        CreatedByUserId: target.id,
        CollectiveId: collective.id,
        status: OrderStatuses.PROCESSING,
      });
      expect(await canSeeLocation(accountant)).to.be.false;
    });

    it('does not grant access to random users', async () => {
      const randomUser = await fakeUser();
      await fakeOrder({
        FromCollectiveId: target.collective.id,
        CreatedByUserId: target.id,
        CollectiveId: collective.id,
        status: OrderStatuses.PROCESSING,
      });
      expect(await canSeeLocation(randomUser)).to.be.false;
    });
  });

  describe('transactionSummary', () => {
    let collectives;
    const today = moment().utc().startOf('day').toDate();
    const lastWeek = moment().utc().subtract(8, 'days').toDate();

    before(async () => {
      const host = await fakeActiveHost();
      collectives = await multiple(fakeCollective, 3, {
        HostCollectiveId: host.id,
        approvedAt: moment().utc().subtract(10, 'days').toDate(),
      });
      await Promise.all(
        collectives.map(async c => {
          await fakeTransaction({
            CollectiveId: c.id,
            kind: TransactionKind.EXPENSE,
            amount: -1000,
            HostCollectiveId: host.id,
            createdAt: today,
          });
          await fakeTransaction({
            CollectiveId: c.id,
            kind: TransactionKind.CONTRIBUTION,
            amount: 1000,
            HostCollectiveId: host.id,
            createdAt: today,
          });
          await fakeTransaction({
            CollectiveId: c.id,
            kind: TransactionKind.HOST_FEE,
            amount: -100,
            HostCollectiveId: host.id,
            createdAt: today,
          });
        }),
      );
      await Promise.all(
        collectives.map(async c => {
          await fakeTransaction({
            CollectiveId: c.id,
            kind: TransactionKind.EXPENSE,
            amount: -2000,
            HostCollectiveId: host.id,
            createdAt: lastWeek,
          });
          await fakeTransaction({
            CollectiveId: c.id,
            kind: TransactionKind.CONTRIBUTION,
            amount: 1500,
            HostCollectiveId: host.id,
            createdAt: lastWeek,
          });
          await fakeTransaction({
            CollectiveId: c.id,
            kind: TransactionKind.HOST_FEE,
            amount: -150,
            HostCollectiveId: host.id,
            createdAt: lastWeek,
          });
        }),
      );
    });

    it('should return the financial summary for a collective', async () => {
      const request = makeRequest();
      const result = await request.loaders.Collective.stats.hostedAccountSummary.buildLoader().load(collectives[0].id);

      expect(result).to.containSubset({
        CollectiveId: collectives[0].id,
        hostCurrency: 'USD',
        expenseCount: 2,
        expenseTotal: 3000,
        expenseMaxValue: 2000,
        expenseDistinctPayee: 2,
        contributionCount: 2,
        contributionTotal: 2500,
        hostFeeTotal: 250,
        spentTotal: 3000,
      });
    });

    it('should return the financial summary for a collective since date', async () => {
      const request = makeRequest();
      const result = await request.loaders.Collective.stats.hostedAccountSummary
        .buildLoader({ dateFrom: moment().utc().subtract(4, 'days').toDate() })
        .load(collectives[0].id);

      expect(result).to.containSubset({
        CollectiveId: collectives[0].id,
        hostCurrency: 'USD',
        expenseCount: 1,
        expenseTotal: 1000,
        expenseMaxValue: 1000,
        expenseDistinctPayee: 1,
        contributionCount: 1,
        contributionTotal: 1000,
        hostFeeTotal: 100,
        spentTotal: 1000,
      });
    });
  });
});

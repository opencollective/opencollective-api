import { expect } from 'chai';
import config from 'config';
import { assert } from 'sinon';

import ActivityTypes from '../../../server/constants/activities';
import ExpenseStatuses from '../../../server/constants/expense-status';
import OrderStatuses from '../../../server/constants/order-status';
import { deleteCollective, isCollectiveDeletable, parseImageServiceUrl } from '../../../server/lib/collectivelib';
import models from '../../../server/models';
import {
  fakeActiveHost,
  fakeActivity,
  fakeAgreement,
  fakeApplication,
  fakeCollective,
  fakeComment,
  fakeConnectedAccount,
  fakeConversation,
  fakeEvent,
  fakeExpense,
  fakeExpenseItem,
  fakeHost,
  fakeHostApplication,
  fakeLegalDocument,
  fakeLocation,
  fakeMember,
  fakeMemberInvitation,
  fakeOrder,
  fakePaymentMethod,
  fakePayoutMethod,
  fakePersonalToken,
  fakePlatformSubscription,
  fakeProject,
  fakeRecurringExpense,
  fakeRequiredLegalDocument,
  fakeTier,
  fakeTransaction,
  fakeTransactionsImport,
  fakeTransactionsImportRow,
  fakeUpdate,
  fakeUser,
  fakeVendor,
  fakeVirtualCard,
  fakeVirtualCardRequest,
} from '../../test-helpers/fake-data';

describe('server/lib/collectivelib', () => {
  describe('isCollectiveDeletable', () => {
    it('returns true for a collective that can be deleted', async () => {
      const collective = await fakeCollective();
      expect(await isCollectiveDeletable(collective)).to.be.true;
    });

    it('returns true for a user that can be deleted', async () => {
      const user = await fakeUser();
      expect(await isCollectiveDeletable(user.collective)).to.be.true;
    });

    it('returns false for fiscal hosts', async () => {
      const host = await fakeHost();
      expect(await isCollectiveDeletable(host)).to.be.false;
    });

    it('returns false if the user is the last admin on an account', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective({ admin: user });
      expect(await isCollectiveDeletable(user.collective)).to.be.false;

      // If we delete the collective, then the user should be deletable
      await collective.destroy();
      expect(await isCollectiveDeletable(user.collective)).to.be.true;
    });

    it('returns true if the user is not the last admin on an account', async () => {
      const user = await fakeUser();
      const otherUser = await fakeUser();
      const collective = await fakeCollective({ admin: user });
      await collective.addUserWithRole(otherUser, 'ADMIN');
      expect(await isCollectiveDeletable(user.collective)).to.be.true;
    });

    it('returns false if the collective has transactions', async () => {
      const collective = await fakeCollective();
      await fakeTransaction({ CollectiveId: collective.id });
      expect(await isCollectiveDeletable(collective)).to.be.false;
    });

    it('returns false if the collective has orders associated with a payment', async () => {
      for (const status of [OrderStatuses.ACTIVE, OrderStatuses.PAID, OrderStatuses.CANCELLED]) {
        const collective = await fakeCollective();
        await fakeOrder({ CollectiveId: collective.id, status });
        expect(await isCollectiveDeletable(collective)).to.be.false;
      }
    });

    it('returns false if the collective has expenses associated with a payment', async () => {
      for (const status of ['SCHEDULED_FOR_PAYMENT', 'PROCESSING', 'PAID']) {
        // Testing FromCollective
        const fromCollective = await fakeCollective();
        await fakeExpense({ FromCollectiveId: fromCollective.id, status });
        expect(await isCollectiveDeletable(fromCollective)).to.be.false;

        // Testing Collective
        const collective = await fakeCollective();
        await fakeExpense({ CollectiveId: collective.id, status });
        expect(await isCollectiveDeletable(collective)).to.be.false;
      }
    });

    it('returns false if the collective has children', async () => {
      const parent = await fakeCollective();
      await fakeEvent({ ParentCollectiveId: parent.id });
      expect(await isCollectiveDeletable(parent)).to.be.false;
    });
  });

  describe('deleteCollective', () => {
    it('should delete a collective and all related models', async () => {
      // Data that should NOT be deleted
      const dataToNotDelete = await Promise.all([
        fakeActivity(),
        fakeUser(),
        fakeActiveHost(),
        fakeVendor(),
        fakeEvent(),
        fakeProject(),
        fakeUpdate(),
        fakeComment(),
        fakeConversation(),
        fakeApplication(),
        fakeOrder(),
        fakeExpense(),
        fakeExpenseItem(),
        fakeRecurringExpense(),
        fakeTransactionsImport(),
        fakeTransactionsImportRow(),
        fakeHostApplication(),
        fakeTier(),
        fakePaymentMethod(),
        fakePayoutMethod(),
        fakeConnectedAccount(),
        fakeVirtualCard(),
        fakeVirtualCardRequest(),
        fakePlatformSubscription(),
        fakePersonalToken(),
        fakeRequiredLegalDocument(),
      ]);

      // Accounts
      const remoteUser = await fakeUser();
      const collective = await fakeActiveHost({ admin: remoteUser });

      // Create related models
      const member = await fakeMember({ CollectiveId: collective.id });
      const memberInvitation = await fakeMemberInvitation({ CollectiveId: collective.id });
      const update = await fakeUpdate({ CollectiveId: collective.id });
      const legalDocument = await fakeLegalDocument({ CollectiveId: collective.id });
      const agreement = await fakeAgreement({ CollectiveId: collective.id });
      const location = await fakeLocation({ CollectiveId: collective.id });
      const conversation = await fakeConversation({ CollectiveId: collective.id });
      const comment = await fakeComment({ CollectiveId: collective.id });
      const application = await fakeApplication({ CollectiveId: collective.id });
      const order = await fakeOrder({ CollectiveId: collective.id, status: OrderStatuses.PENDING });
      const expense = await fakeExpense({ CollectiveId: collective.id, status: ExpenseStatuses.DRAFT });
      const expenseItem = await fakeExpenseItem({ ExpenseId: expense.id });
      const recurringExpense = await fakeRecurringExpense({ CollectiveId: collective.id });
      const transactionsImport = await fakeTransactionsImport({ CollectiveId: collective.id });
      const transactionsImportRow = await fakeTransactionsImportRow({ TransactionsImportId: transactionsImport.id });
      const hostApplication = await fakeHostApplication({ CollectiveId: collective.id });
      const tier = await fakeTier({ CollectiveId: collective.id });
      const paymentMethod = await fakePaymentMethod({ CollectiveId: collective.id });
      const payoutMethod = await fakePayoutMethod({ CollectiveId: collective.id });
      const connectedAccount = await fakeConnectedAccount({ CollectiveId: collective.id });
      const virtualCard = await fakeVirtualCard({ CollectiveId: collective.id, HostCollectiveId: collective.id });
      const virtualCardRequest = await fakeVirtualCardRequest({ CollectiveId: collective.id });
      const platformSubscription = await fakePlatformSubscription({ CollectiveId: collective.id });
      const personalToken = await fakePersonalToken({ CollectiveId: collective.id });
      const requiredLegalDocument = await fakeRequiredLegalDocument({ HostCollectiveId: collective.id });

      // Delete the collective
      await deleteCollective(collective, remoteUser);

      // Verify all related models are deleted
      expect(await models.Member.findByPk(member.id)).to.be.null;
      expect(await models.MemberInvitation.findByPk(memberInvitation.id)).to.be.null;
      expect(await models.Update.findByPk(update.id)).to.be.null;
      expect(await models.LegalDocument.findByPk(legalDocument.id)).to.be.null;
      expect(await models.Agreement.findByPk(agreement.id)).to.be.null;
      expect(await models.Location.findByPk(location.id)).to.be.null;
      expect(await models.Conversation.findByPk(conversation.id)).to.be.null;
      expect(await models.Comment.findByPk(comment.id)).to.be.null;
      expect(await models.Application.findByPk(application.id)).to.be.null;
      expect(await models.Order.findByPk(order.id)).to.be.null;
      expect(await models.Expense.findByPk(expense.id)).to.be.null;
      expect(await models.ExpenseItem.findByPk(expenseItem.id)).to.be.null;
      expect(await models.RecurringExpense.findByPk(recurringExpense.id)).to.be.null;
      expect(await models.TransactionsImport.findByPk(transactionsImport.id)).to.be.null;
      expect(await models.TransactionsImportRow.findByPk(transactionsImportRow.id)).to.be.null;
      expect(await models.HostApplication.findByPk(hostApplication.id)).to.be.null;
      expect(await models.Tier.findByPk(tier.id)).to.be.null;
      expect(await models.PaymentMethod.findByPk(paymentMethod.id)).to.be.null;
      expect(await models.PayoutMethod.findByPk(payoutMethod.id)).to.be.null;
      expect(await models.ConnectedAccount.findByPk(connectedAccount.id)).to.be.null;
      expect(await models.VirtualCard.findByPk(virtualCard.id)).to.be.null;
      expect(await models.VirtualCardRequest.findByPk(virtualCardRequest.id)).to.be.null;
      expect(await models.PlatformSubscription.findByPk(platformSubscription.id)).to.be.null;
      expect(await models.PersonalToken.findByPk(personalToken.id)).to.be.null;
      expect(await models.RequiredLegalDocument.findByPk(requiredLegalDocument.id)).to.be.null;
      expect(await models.Collective.findByPk(collective.id)).to.be.null;

      // Verify data that should NOT be deleted still exists
      for (const data of dataToNotDelete) {
        try {
          await data.reload();
        } catch (error) {
          assert.fail(`Data should not have been deleted: ${data.constructor.name}. Received: ${error.message}`);
        }
      }
    });

    it('should delete member invitations by both CollectiveId and MemberCollectiveId', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });

      const memberInvitation1 = await fakeMemberInvitation({ CollectiveId: collective.id });
      const memberInvitation2 = await fakeMemberInvitation({ MemberCollectiveId: collective.id });

      await deleteCollective(collective, remoteUser);

      expect(await models.MemberInvitation.findByPk(memberInvitation1.id)).to.be.null;
      expect(await models.MemberInvitation.findByPk(memberInvitation2.id)).to.be.null;
    });

    it('should delete agreements by both CollectiveId and HostCollectiveId', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });
      const agreement1 = await fakeAgreement({ CollectiveId: collective.id });
      const agreement2 = await fakeAgreement({ HostCollectiveId: collective.id });

      await deleteCollective(collective, remoteUser);

      expect(await models.Agreement.findByPk(agreement1.id)).to.be.null;
      expect(await models.Agreement.findByPk(agreement2.id)).to.be.null;
    });

    it('should delete expenses by CollectiveId, FromCollectiveId, and UserId (for user collectives)', async () => {
      const user = await fakeUser();
      const expense1 = await fakeExpense({ CollectiveId: user.collective.id, status: 'DRAFT' });
      const expense2 = await fakeExpense({ FromCollectiveId: user.collective.id, status: 'DRAFT' });
      const expense3 = await fakeExpense({ UserId: user.id, status: 'DRAFT' });

      await deleteCollective(user.collective, user);

      expect(await models.Expense.findByPk(expense1.id)).to.be.null;
      expect(await models.Expense.findByPk(expense2.id)).to.be.null;
      expect(await models.Expense.findByPk(expense3.id)).to.be.null;
    });

    it('should delete expense items when expenses are deleted', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });
      const expense = await fakeExpense({ CollectiveId: collective.id, status: 'DRAFT' });
      const expenseItem = await fakeExpenseItem({ ExpenseId: expense.id });

      await deleteCollective(collective, remoteUser);

      expect((await expense.reload({ paranoid: false })).deletedAt).to.not.be.null;
      expect((await expenseItem.reload({ paranoid: false })).deletedAt).to.not.be.null;
    });

    it('should delete applications by CollectiveId and CreatedByUserId (for user collectives)', async () => {
      const user = await fakeUser();
      const application1 = await fakeApplication({ CollectiveId: user.collective.id });
      const application2 = await fakeApplication({ CreatedByUserId: user.id });

      await deleteCollective(user.collective, user);

      expect(await models.Application.findByPk(application1.id)).to.be.null;
      expect(await models.Application.findByPk(application2.id)).to.be.null;
    });

    it('should delete orders by FromCollectiveId and CollectiveId (only non-final statuses)', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });
      const order1 = await fakeOrder({ CollectiveId: collective.id, status: OrderStatuses.PENDING });
      const order2 = await fakeOrder({ FromCollectiveId: collective.id, status: OrderStatuses.ERROR });
      const order3 = await fakeOrder({ CollectiveId: collective.id, status: OrderStatuses.PAID });
      const order4 = await fakeOrder({ CollectiveId: collective.id, status: OrderStatuses.ACTIVE });
      const order5 = await fakeOrder({ CollectiveId: collective.id, status: OrderStatuses.CANCELLED });

      await deleteCollective(collective, remoteUser);

      expect(await models.Order.findByPk(order1.id)).to.be.null;
      expect(await models.Order.findByPk(order2.id)).to.be.null;
      expect(await models.Order.findByPk(order3.id)).to.exist; // Should not be deleted
      expect(await models.Order.findByPk(order4.id)).to.exist; // Should not be deleted
      expect(await models.Order.findByPk(order5.id)).to.exist; // Should not be deleted
    });

    it('should delete expenses only with non-final statuses', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });
      const expense1 = await fakeExpense({ CollectiveId: collective.id, status: 'DRAFT' });
      const expense2 = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
      const expense3 = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
      const expense4 = await fakeExpense({ CollectiveId: collective.id, status: 'PROCESSING' });
      const expense5 = await fakeExpense({ CollectiveId: collective.id, status: 'SCHEDULED_FOR_PAYMENT' });

      await deleteCollective(collective, remoteUser);

      expect(await models.Expense.findByPk(expense1.id)).to.be.null;
      expect(await models.Expense.findByPk(expense2.id)).to.be.null;
      expect(await models.Expense.findByPk(expense3.id)).to.exist; // Should not be deleted
      expect(await models.Expense.findByPk(expense4.id)).to.exist; // Should not be deleted
      expect(await models.Expense.findByPk(expense5.id)).to.exist; // Should not be deleted
    });

    it('should delete host applications by CollectiveId and HostCollectiveId', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });
      const hostApplication1 = await fakeHostApplication({ CollectiveId: collective.id });
      const hostApplication2 = await fakeHostApplication({ HostCollectiveId: collective.id });

      await deleteCollective(collective, remoteUser);

      expect(await models.HostApplication.findByPk(hostApplication1.id)).to.be.null;
      expect(await models.HostApplication.findByPk(hostApplication2.id)).to.be.null;
    });

    it('should delete virtual cards by CollectiveId and HostCollectiveId', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });
      const virtualCard1 = await fakeVirtualCard({ CollectiveId: collective.id });
      const virtualCard2 = await fakeVirtualCard({ HostCollectiveId: collective.id });

      await deleteCollective(collective, remoteUser);

      expect(await models.VirtualCard.findByPk(virtualCard1.id)).to.be.null;
      expect(await models.VirtualCard.findByPk(virtualCard2.id)).to.be.null;
    });

    it('should delete virtual card requests by CollectiveId and HostCollectiveId', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });
      const virtualCardRequest1 = await fakeVirtualCardRequest({ CollectiveId: collective.id });
      const virtualCardRequest2 = await fakeVirtualCardRequest({ HostCollectiveId: collective.id });

      await deleteCollective(collective, remoteUser);

      expect(await models.VirtualCardRequest.findByPk(virtualCardRequest1.id)).to.be.null;
      expect(await models.VirtualCardRequest.findByPk(virtualCardRequest2.id)).to.be.null;
    });

    describe('Users', () => {
      it('should delete personal tokens by CollectiveId and UserId', async () => {
        const user = await fakeUser();
        const personalToken1 = await fakePersonalToken({ CollectiveId: user.collective.id });
        const personalToken2 = await fakePersonalToken({ UserId: user.id });

        await deleteCollective(user.collective, user);

        expect(await models.PersonalToken.findByPk(personalToken1.id)).to.be.null;
        expect(await models.PersonalToken.findByPk(personalToken2.id)).to.be.null;
      });

      it('should delete the user when deleting a user collective', async () => {
        const user = await fakeUser();
        await deleteCollective(user.collective, user);
        expect(await models.User.findByPk(user.id)).to.be.null;
      });

      it('should not delete the user when deleting a non-user collective', async () => {
        const remoteUser = await fakeUser();
        const collective = await fakeCollective({ admin: remoteUser });
        const otherUser = await fakeUser();
        await deleteCollective(collective, remoteUser);

        expect(await models.User.findByPk(otherUser.id)).to.exist;
      });
    });

    it('should NOT delete the admin profiles when deleting a collective', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });
      await deleteCollective(collective, remoteUser);

      expect((await remoteUser.collective.reload({ paranoid: false })).deletedAt).to.be.null;
    });

    it('should create a COLLECTIVE_DELETED activity after deletion', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });
      await deleteCollective(collective, remoteUser);

      const activity = await models.Activity.findOne({
        where: {
          type: ActivityTypes.COLLECTIVE_DELETED,
          CollectiveId: collective.id,
          UserId: remoteUser.id,
        },
      });

      expect(activity).to.exist;
      expect(activity.FromCollectiveId).to.equal(collective.id);
    });

    it('should handle deletion in a transaction (rollback on error)', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });
      const member = await fakeMember({ CollectiveId: collective.id });

      // Mock an error during deletion
      const originalDestroy = models.Member.destroy;
      models.Member.destroy = async function () {
        throw new Error('Simulated error');
      };

      try {
        await deleteCollective(collective, remoteUser);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Simulated error');
        // Verify transaction was rolled back - member should still exist
        expect(await models.Member.findByPk(member.id)).to.exist;
      } finally {
        models.Member.destroy = originalDestroy;
      }
    });
  });

  describe('parseImageServiceUrl', () => {
    it('parses valid image URLs without size', () => {
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/background.jpg`)).to.deep.equal({
        slug: 'babel',
        hash: '9a38a01',
        type: 'background',
        format: 'jpg',
        height: undefined,
      });

      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/avatar.jpg?foo=bar`)).to.deep.equal({
        slug: 'babel',
        hash: '9a38a01',
        type: 'avatar',
        format: 'jpg',
        height: undefined,
      });

      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/logo.jpg?foo=bar`)).to.deep.equal({
        slug: 'babel',
        hash: '9a38a01',
        type: 'logo',
        format: 'jpg',
        height: undefined,
      });
    });

    it('parses valid image URLs with size', () => {
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/background/960.jpg`)).to.deep.equal({
        slug: 'babel',
        hash: '9a38a01',
        type: 'background',
        format: 'jpg',
        height: 960,
      });

      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/avatar/200.jpg`)).to.deep.equal({
        slug: 'babel',
        hash: '9a38a01',
        type: 'avatar',
        format: 'jpg',
        height: 200,
      });

      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/logo/300.PNG`)).to.deep.equal({
        slug: 'babel',
        hash: '9a38a01',
        type: 'logo',
        format: 'PNG',
        height: 300,
      });
    });

    it('returns null for invalid image URLs', () => {
      expect(parseImageServiceUrl(``)).to.be.null;
      expect(parseImageServiceUrl(`https://random-domain.com/babel/9a38a01/background.jpg`)).to.be.null;
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/invalid.jpg`)).to.be.null;
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/invalid.jpg`)).to.be.null;
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/background/invalid.jpg`)).to.be.null;
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/avatar/invalid.jpg`)).to.be.null;
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/logo/invalid.jpg`)).to.be.null;
    });
  });
});

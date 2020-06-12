import { expect } from 'chai';

import {
  canApprove,
  canComment,
  canDeleteExpense,
  canEditExpense,
  canMarkAsUnpaid,
  canPayExpense,
  canReject,
  canSeeExpenseAttachments,
  canSeeExpenseInvoiceInfo,
  canSeeExpensePayeeLocation,
  canSeeExpensePayoutMethod,
  canUnapprove,
} from '../../../../server/graphql/common/expenses';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import { fakeCollective, fakeExpense, fakePayoutMethod, fakeUser } from '../../../test-helpers/fake-data';
import { makeRequest } from '../../../utils';

describe('server/graphql/common/expenses', () => {
  let expense, collective, collectiveAdmin, hostAdmin, limitedHostAdmin, expenseOwner, randomUser;
  let publicReq, randomUserReq, collectiveAdminReq, hostAdminReq, limitedHostAdminReq, expenseOwnerReq;

  before(async () => {
    randomUser = await fakeUser();
    collectiveAdmin = await fakeUser();
    hostAdmin = await fakeUser();
    limitedHostAdmin = await fakeUser();
    expenseOwner = await fakeUser();
    collective = await fakeCollective();
    const payoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.OTHER });
    expense = await fakeExpense({
      CollectiveId: collective.id,
      FromCollectiveId: expenseOwner.CollectiveId,
      PayoutMethodId: payoutMethod.id,
    });
    await collective.addUserWithRole(collectiveAdmin, 'ADMIN');
    await collective.host.addUserWithRole(hostAdmin, 'ADMIN');

    await collectiveAdmin.populateRoles();
    await hostAdmin.populateRoles();
    await limitedHostAdmin.populateRoles();

    await limitedHostAdmin.update({ data: { features: { ALL: false } } });

    publicReq = makeRequest();
    randomUserReq = makeRequest(randomUser);
    collectiveAdminReq = makeRequest(collectiveAdmin);
    hostAdminReq = makeRequest(hostAdmin);
    limitedHostAdminReq = makeRequest(limitedHostAdmin);
    expenseOwnerReq = makeRequest(expenseOwner);
  });

  describe('canSeeExpenseAttachments', () => {
    it('can see only if owner, collective admin or host admin', async () => {
      expect(await canSeeExpenseAttachments(publicReq, expense)).to.be.false;
      expect(await canSeeExpenseAttachments(randomUserReq, expense)).to.be.false;
      expect(await canSeeExpenseAttachments(collectiveAdminReq, expense)).to.be.true;
      expect(await canSeeExpenseAttachments(hostAdminReq, expense)).to.be.true;
      expect(await canSeeExpenseAttachments(expenseOwnerReq, expense)).to.be.true;
      expect(await canSeeExpenseAttachments(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canSeeExpensePayoutMethod', () => {
    it('can see only if owner or host admin', async () => {
      expect(await canSeeExpensePayoutMethod(publicReq, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(randomUserReq, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(collectiveAdminReq, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(hostAdminReq, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(expenseOwnerReq, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canSeeExpenseInvoiceInfo', () => {
    it('can see only if owner or host admin', async () => {
      expect(await canSeeExpenseInvoiceInfo(publicReq, expense)).to.be.false;
      expect(await canSeeExpenseInvoiceInfo(randomUserReq, expense)).to.be.false;
      expect(await canSeeExpenseInvoiceInfo(collectiveAdminReq, expense)).to.be.true;
      expect(await canSeeExpenseInvoiceInfo(hostAdminReq, expense)).to.be.true;
      expect(await canSeeExpenseInvoiceInfo(expenseOwnerReq, expense)).to.be.true;
      expect(await canSeeExpenseInvoiceInfo(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canSeeExpensePayeeLocation', () => {
    it('can see only if owner or host admin', async () => {
      expect(await canSeeExpensePayeeLocation(publicReq, expense)).to.be.false;
      expect(await canSeeExpensePayeeLocation(randomUserReq, expense)).to.be.false;
      expect(await canSeeExpensePayeeLocation(collectiveAdminReq, expense)).to.be.true;
      expect(await canSeeExpensePayeeLocation(hostAdminReq, expense)).to.be.true;
      expect(await canSeeExpensePayeeLocation(expenseOwnerReq, expense)).to.be.true;
      expect(await canSeeExpensePayeeLocation(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canEditExpense', () => {
    it('only if not processing or paid', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await canEditExpense(hostAdminReq, expense)).to.be.true;
      await expense.update({ status: 'APPROVED' });
      expect(await canEditExpense(hostAdminReq, expense)).to.be.true;
      await expense.update({ status: 'ERROR' });
      expect(await canEditExpense(hostAdminReq, expense)).to.be.true;
      await expense.update({ status: 'REJECTED' });
      expect(await canEditExpense(hostAdminReq, expense)).to.be.true;
      await expense.update({ status: 'PROCESSING' });
      expect(await canEditExpense(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canEditExpense(hostAdminReq, expense)).to.be.false;
    });

    it('only if owner or host admin', async () => {
      await expense.update({ status: 'REJECTED' });
      expect(await canEditExpense(publicReq, expense)).to.be.false;
      expect(await canEditExpense(randomUserReq, expense)).to.be.false;
      expect(await canEditExpense(collectiveAdminReq, expense)).to.be.true;
      expect(await canEditExpense(hostAdminReq, expense)).to.be.true;
      expect(await canEditExpense(expenseOwnerReq, expense)).to.be.true;
      expect(await canEditExpense(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canDeleteExpense', () => {
    it('only if rejected', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await canDeleteExpense(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'APPROVED' });
      expect(await canDeleteExpense(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'PROCESSING' });
      expect(await canDeleteExpense(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canDeleteExpense(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canDeleteExpense(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canDeleteExpense(hostAdminReq, expense)).to.be.true;
    });

    it('only if owner, collective admin or host admin', async () => {
      await expense.update({ status: 'REJECTED' });
      expect(await canDeleteExpense(publicReq, expense)).to.be.false;
      expect(await canDeleteExpense(randomUserReq, expense)).to.be.false;
      expect(await canDeleteExpense(collectiveAdminReq, expense)).to.be.true;
      expect(await canDeleteExpense(hostAdminReq, expense)).to.be.true;
      expect(await canDeleteExpense(expenseOwnerReq, expense)).to.be.true;
      expect(await canDeleteExpense(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canPayExpense', () => {
    it('only if approved or error', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await canPayExpense(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'APPROVED' });
      expect(await canPayExpense(hostAdminReq, expense)).to.be.true;
      await expense.update({ status: 'PROCESSING' });
      expect(await canPayExpense(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canPayExpense(hostAdminReq, expense)).to.be.true;
      await expense.update({ status: 'PAID' });
      expect(await canPayExpense(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canPayExpense(hostAdminReq, expense)).to.be.false;
    });

    it('only if host admin', async () => {
      await expense.update({ status: 'APPROVED' });
      expect(await canPayExpense(publicReq, expense)).to.be.false;
      expect(await canPayExpense(randomUserReq, expense)).to.be.false;
      expect(await canPayExpense(collectiveAdminReq, expense)).to.be.false;
      expect(await canPayExpense(hostAdminReq, expense)).to.be.true;
      expect(await canPayExpense(expenseOwnerReq, expense)).to.be.false;
      expect(await canPayExpense(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canApprove', () => {
    it('only if pending or rejected', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await canApprove(hostAdminReq, expense)).to.be.true;
      await expense.update({ status: 'APPROVED' });
      expect(await canApprove(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'PROCESSING' });
      expect(await canApprove(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canApprove(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canApprove(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canApprove(hostAdminReq, expense)).to.be.true;
    });

    it('only if host admin or collective admin', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await canApprove(publicReq, expense)).to.be.false;
      expect(await canApprove(randomUserReq, expense)).to.be.false;
      expect(await canApprove(collectiveAdminReq, expense)).to.be.true;
      expect(await canApprove(hostAdminReq, expense)).to.be.true;
      expect(await canApprove(expenseOwnerReq, expense)).to.be.false;
      expect(await canApprove(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canReject', () => {
    it('only if pending', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await canReject(hostAdminReq, expense)).to.be.true;
      await expense.update({ status: 'APPROVED' });
      expect(await canReject(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'PROCESSING' });
      expect(await canReject(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canReject(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canReject(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canReject(hostAdminReq, expense)).to.be.false;
    });

    it('only if host admin or collective admin', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await canReject(publicReq, expense)).to.be.false;
      expect(await canReject(randomUserReq, expense)).to.be.false;
      expect(await canReject(collectiveAdminReq, expense)).to.be.true;
      expect(await canReject(hostAdminReq, expense)).to.be.true;
      expect(await canReject(expenseOwnerReq, expense)).to.be.false;
      expect(await canReject(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canUnapprove', () => {
    it('only if approved', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await canUnapprove(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'APPROVED' });
      expect(await canUnapprove(hostAdminReq, expense)).to.be.true;
      await expense.update({ status: 'PROCESSING' });
      expect(await canUnapprove(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canUnapprove(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canUnapprove(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canUnapprove(hostAdminReq, expense)).to.be.false;
    });

    it('only if host admin or collective admin', async () => {
      await expense.update({ status: 'APPROVED' });
      expect(await canUnapprove(publicReq, expense)).to.be.false;
      expect(await canUnapprove(randomUserReq, expense)).to.be.false;
      expect(await canUnapprove(collectiveAdminReq, expense)).to.be.true;
      expect(await canUnapprove(hostAdminReq, expense)).to.be.true;
      expect(await canUnapprove(expenseOwnerReq, expense)).to.be.false;
      expect(await canUnapprove(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canMarkAsUnpaid', () => {
    it('only if paid', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await canMarkAsUnpaid(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'APPROVED' });
      expect(await canMarkAsUnpaid(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'PROCESSING' });
      expect(await canMarkAsUnpaid(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canMarkAsUnpaid(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canMarkAsUnpaid(hostAdminReq, expense)).to.be.true;
      await expense.update({ status: 'REJECTED' });
      expect(await canMarkAsUnpaid(hostAdminReq, expense)).to.be.false;
    });

    it('only if host admin', async () => {
      await expense.update({ status: 'PAID' });
      expect(await canMarkAsUnpaid(publicReq, expense)).to.be.false;
      expect(await canMarkAsUnpaid(randomUserReq, expense)).to.be.false;
      expect(await canMarkAsUnpaid(collectiveAdminReq, expense)).to.be.false;
      expect(await canMarkAsUnpaid(hostAdminReq, expense)).to.be.true;
      expect(await canMarkAsUnpaid(expenseOwnerReq, expense)).to.be.false;
      expect(await canMarkAsUnpaid(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canComment', () => {
    it('only if owner, collective admin or host admin', async () => {
      await expense.update({ status: 'PAID' });
      expect(await canComment(publicReq, expense)).to.be.false;
      expect(await canComment(randomUserReq, expense)).to.be.false;
      expect(await canComment(collectiveAdminReq, expense)).to.be.true;
      expect(await canComment(hostAdminReq, expense)).to.be.true;
      expect(await canComment(expenseOwnerReq, expense)).to.be.true;
      expect(await canComment(limitedHostAdminReq, expense)).to.be.false;
    });
  });
});

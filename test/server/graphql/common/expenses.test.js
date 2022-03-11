import { expect } from 'chai';

import { expenseStatus } from '../../../../server/constants';
import { EXPENSE_PERMISSION_ERROR_CODES } from '../../../../server/constants/permissions';
import POLICIES from '../../../../server/constants/policies';
import {
  canApprove,
  canComment,
  canDeleteExpense,
  canEditExpense,
  canEditExpenseTags,
  canMarkAsUnpaid,
  canPayExpense,
  canReject,
  canSeeExpenseAttachments,
  canSeeExpenseInvoiceInfo,
  canSeeExpensePayeeLocation,
  canSeeExpensePayoutMethod,
  canUnapprove,
  canUnschedulePayment,
  getExpenseAmountInDifferentCurrency,
  isAccountHolderNameAndLegalNameMatch,
} from '../../../../server/graphql/common/expenses';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import { fakeCollective, fakeExpense, fakePayoutMethod, fakeUser } from '../../../test-helpers/fake-data';
import { getApolloErrorCode, makeRequest } from '../../../utils';

describe('server/graphql/common/expenses', () => {
  let expense,
    collective,
    collectiveAdmin,
    collectiveAccountant,
    hostAdmin,
    hostAccountant,
    limitedHostAdmin,
    expenseOwner,
    randomUser;

  let publicReq,
    randomUserReq,
    collectiveAdminReq,
    collectiveAccountantReq,
    hostAdminReq,
    hostAccountantReq,
    limitedHostAdminReq,
    expenseOwnerReq;

  before(async () => {
    randomUser = await fakeUser();
    collectiveAdmin = await fakeUser();
    collectiveAccountant = await fakeUser();
    hostAdmin = await fakeUser();
    hostAccountant = await fakeUser();
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
    await collective.addUserWithRole(collectiveAccountant, 'ACCOUNTANT');
    await collective.host.addUserWithRole(hostAdmin, 'ADMIN');
    await collective.host.addUserWithRole(hostAccountant, 'ACCOUNTANT');

    await collectiveAdmin.populateRoles();
    await hostAdmin.populateRoles();
    await limitedHostAdmin.populateRoles();
    await collectiveAccountant.populateRoles();
    await hostAccountant.populateRoles();

    await limitedHostAdmin.update({ data: { features: { ALL: false } } });

    publicReq = makeRequest();
    randomUserReq = makeRequest(randomUser);
    collectiveAdminReq = makeRequest(collectiveAdmin);
    hostAdminReq = makeRequest(hostAdmin);
    limitedHostAdminReq = makeRequest(limitedHostAdmin);
    expenseOwnerReq = makeRequest(expenseOwner);
    collectiveAccountantReq = makeRequest(collectiveAccountant);
    hostAccountantReq = makeRequest(hostAccountant);
  });

  describe('canSeeExpenseAttachments', () => {
    it('can see only with the allowed roles or host admin', async () => {
      expect(await canSeeExpenseAttachments(publicReq, expense)).to.be.false;
      expect(await canSeeExpenseAttachments(randomUserReq, expense)).to.be.false;
      expect(await canSeeExpenseAttachments(collectiveAdminReq, expense)).to.be.true;
      expect(await canSeeExpenseAttachments(collectiveAccountantReq, expense)).to.be.true;
      expect(await canSeeExpenseAttachments(hostAdminReq, expense)).to.be.true;
      expect(await canSeeExpenseAttachments(hostAccountantReq, expense)).to.be.true;
      expect(await canSeeExpenseAttachments(expenseOwnerReq, expense)).to.be.true;
      expect(await canSeeExpenseAttachments(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canSeeExpensePayoutMethod', () => {
    it('can see only with the allowed roles', async () => {
      expect(await canSeeExpensePayoutMethod(publicReq, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(randomUserReq, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(collectiveAdminReq, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(collectiveAccountantReq, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(hostAdminReq, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(hostAccountantReq, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(expenseOwnerReq, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canSeeExpenseInvoiceInfo', () => {
    it('can see only with the allowed roles', async () => {
      expect(await canSeeExpenseInvoiceInfo(publicReq, expense)).to.be.false;
      expect(await canSeeExpenseInvoiceInfo(randomUserReq, expense)).to.be.false;
      expect(await canSeeExpenseInvoiceInfo(collectiveAdminReq, expense)).to.be.true;
      expect(await canSeeExpenseInvoiceInfo(collectiveAccountantReq, expense)).to.be.true;
      expect(await canSeeExpenseInvoiceInfo(hostAdminReq, expense)).to.be.true;
      expect(await canSeeExpenseInvoiceInfo(hostAccountantReq, expense)).to.be.true;
      expect(await canSeeExpenseInvoiceInfo(expenseOwnerReq, expense)).to.be.true;
      expect(await canSeeExpenseInvoiceInfo(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canSeeExpensePayeeLocation', () => {
    it('can see only with the allowed roles', async () => {
      expect(await canSeeExpensePayeeLocation(publicReq, expense)).to.be.false;
      expect(await canSeeExpensePayeeLocation(randomUserReq, expense)).to.be.false;
      expect(await canSeeExpensePayeeLocation(collectiveAdminReq, expense)).to.be.true;
      expect(await canSeeExpensePayeeLocation(collectiveAccountantReq, expense)).to.be.true;
      expect(await canSeeExpensePayeeLocation(hostAdminReq, expense)).to.be.true;
      expect(await canSeeExpensePayeeLocation(hostAccountantReq, expense)).to.be.true;
      expect(await canSeeExpensePayeeLocation(expenseOwnerReq, expense)).to.be.true;
      expect(await canSeeExpensePayeeLocation(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canEditExpense', () => {
    it('only if not processing, paid, draft or scheduled for payment', async () => {
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
      await expense.update({ status: 'DRAFT' });
      expect(await canEditExpense(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
      expect(await canEditExpense(hostAdminReq, expense)).to.be.false;
    });

    it('only with the allowed roles', async () => {
      await expense.update({ status: 'REJECTED' });
      expect(await canEditExpense(publicReq, expense)).to.be.false;
      expect(await canEditExpense(randomUserReq, expense)).to.be.false;
      expect(await canEditExpense(collectiveAdminReq, expense)).to.be.true;
      expect(await canEditExpense(hostAdminReq, expense)).to.be.true;
      expect(await canEditExpense(collectiveAccountantReq, expense)).to.be.false;
      expect(await canEditExpense(hostAccountantReq, expense)).to.be.false;
      expect(await canEditExpense(expenseOwnerReq, expense)).to.be.true;
      expect(await canEditExpense(limitedHostAdminReq, expense)).to.be.false;
    });
  });

  describe('canEditExpenseTags', () => {
    it('only if not processing, paid, draft or scheduled for payment', async () => {
      // Can always edit tags if collective admin
      for (const status of Object.values(expenseStatus)) {
        await expense.update({ status });
        expect(await canEditExpenseTags(hostAdminReq, expense)).to.be.true;
      }

      // But owner can't update them if it's paid
      await expense.update({ status: 'PAID' });
      expect(await canEditExpenseTags(expenseOwnerReq, expense)).to.be.false;
    });

    it('only with the allowed roles', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await canEditExpenseTags(publicReq, expense)).to.be.false;
      expect(await canEditExpenseTags(randomUserReq, expense)).to.be.false;
      expect(await canEditExpenseTags(collectiveAdminReq, expense)).to.be.true;
      expect(await canEditExpenseTags(hostAdminReq, expense)).to.be.true;
      expect(await canEditExpenseTags(collectiveAccountantReq, expense)).to.be.false;
      expect(await canEditExpenseTags(hostAccountantReq, expense)).to.be.false;
      expect(await canEditExpenseTags(expenseOwnerReq, expense)).to.be.true;
      expect(await canEditExpenseTags(limitedHostAdminReq, expense)).to.be.false;
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

    it('only with the allowed roles', async () => {
      await expense.update({ status: 'REJECTED' });
      expect(await canDeleteExpense(publicReq, expense)).to.be.false;
      expect(await canDeleteExpense(randomUserReq, expense)).to.be.false;
      expect(await canDeleteExpense(collectiveAdminReq, expense)).to.be.true;
      expect(await canDeleteExpense(hostAdminReq, expense)).to.be.true;
      expect(await canDeleteExpense(expenseOwnerReq, expense)).to.be.true;
      expect(await canDeleteExpense(limitedHostAdminReq, expense)).to.be.false;
      expect(await canDeleteExpense(collectiveAccountantReq, expense)).to.be.false;
      expect(await canDeleteExpense(hostAccountantReq, expense)).to.be.false;
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

    it('only with the allowed roles', async () => {
      await expense.update({ status: 'APPROVED' });
      expect(await canPayExpense(publicReq, expense)).to.be.false;
      expect(await canPayExpense(randomUserReq, expense)).to.be.false;
      expect(await canPayExpense(collectiveAdminReq, expense)).to.be.false;
      expect(await canPayExpense(hostAdminReq, expense)).to.be.true;
      expect(await canPayExpense(expenseOwnerReq, expense)).to.be.false;
      expect(await canPayExpense(limitedHostAdminReq, expense)).to.be.false;
      expect(await canPayExpense(collectiveAccountantReq, expense)).to.be.false;
      expect(await canPayExpense(hostAccountantReq, expense)).to.be.false;
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

    it('only with the allowed roles', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await canApprove(publicReq, expense)).to.be.false;
      expect(await canApprove(randomUserReq, expense)).to.be.false;
      expect(await canApprove(collectiveAdminReq, expense)).to.be.true;
      expect(await canApprove(hostAdminReq, expense)).to.be.true;
      expect(await canApprove(expenseOwnerReq, expense)).to.be.false;
      expect(await canApprove(limitedHostAdminReq, expense)).to.be.false;
      expect(await canApprove(collectiveAccountantReq, expense)).to.be.false;
      expect(await canApprove(hostAccountantReq, expense)).to.be.false;
    });

    it('throws informative error if options.throw is set', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await getApolloErrorCode(canApprove(publicReq, expense, { throw: true }))).to.be.equal(
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE,
      );
      expect(await getApolloErrorCode(canApprove(expenseOwnerReq, expense, { throw: true }))).to.be.equal(
        EXPENSE_PERMISSION_ERROR_CODES.MINIMAL_CONDITION_NOT_MET,
      );

      await expense.update({ status: 'APPROVED' });
      expect(await getApolloErrorCode(canApprove(publicReq, expense, { throw: true }))).to.be.equal(
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    });

    it('throws if author is trying to approve and EXPENSE_AUTHOR_CANNOT_APPROVE policy is set', async () => {
      const payoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.OTHER });
      await collective.setPolicies([POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]);
      const newExpense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: collectiveAdmin.CollectiveId,
        PayoutMethodId: payoutMethod.id,
        UserId: collectiveAdmin.id,
      });

      await expense.update({ status: 'PENDING' });
      expect(await getApolloErrorCode(canApprove(collectiveAdminReq, newExpense, { throw: true }))).to.be.equal(
        EXPENSE_PERMISSION_ERROR_CODES.AUTHOR_CANNOT_APPROVE,
      );
      expect(await canApprove(collectiveAdminReq, newExpense)).to.be.false;
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

    it('only with the allowed roles', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await canReject(publicReq, expense)).to.be.false;
      expect(await canReject(randomUserReq, expense)).to.be.false;
      expect(await canReject(collectiveAdminReq, expense)).to.be.true;
      expect(await canReject(hostAdminReq, expense)).to.be.true;
      expect(await canReject(expenseOwnerReq, expense)).to.be.false;
      expect(await canReject(limitedHostAdminReq, expense)).to.be.false;
      expect(await canReject(collectiveAccountantReq, expense)).to.be.false;
      expect(await canReject(hostAccountantReq, expense)).to.be.false;
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
      expect(await canUnapprove(hostAdminReq, expense)).to.be.true;
      await expense.update({ status: 'PAID' });
      expect(await canUnapprove(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canUnapprove(hostAdminReq, expense)).to.be.false;
    });

    it('only with the allowed roles', async () => {
      await expense.update({ status: 'APPROVED' });
      expect(await canUnapprove(publicReq, expense)).to.be.false;
      expect(await canUnapprove(randomUserReq, expense)).to.be.false;
      expect(await canUnapprove(collectiveAdminReq, expense)).to.be.true;
      expect(await canUnapprove(hostAdminReq, expense)).to.be.true;
      expect(await canUnapprove(expenseOwnerReq, expense)).to.be.false;
      expect(await canUnapprove(limitedHostAdminReq, expense)).to.be.false;
      expect(await canUnapprove(collectiveAccountantReq, expense)).to.be.false;
      expect(await canUnapprove(hostAccountantReq, expense)).to.be.false;
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

    it('only with the allowed roles', async () => {
      await expense.update({ status: 'PAID' });
      expect(await canMarkAsUnpaid(publicReq, expense)).to.be.false;
      expect(await canMarkAsUnpaid(randomUserReq, expense)).to.be.false;
      expect(await canMarkAsUnpaid(collectiveAdminReq, expense)).to.be.false;
      expect(await canMarkAsUnpaid(hostAdminReq, expense)).to.be.true;
      expect(await canMarkAsUnpaid(expenseOwnerReq, expense)).to.be.false;
      expect(await canMarkAsUnpaid(limitedHostAdminReq, expense)).to.be.false;
      expect(await canMarkAsUnpaid(collectiveAccountantReq, expense)).to.be.false;
      expect(await canMarkAsUnpaid(hostAccountantReq, expense)).to.be.false;
    });
  });

  describe('canComment', () => {
    it('only with the allowed roles', async () => {
      await expense.update({ status: 'PAID' });
      expect(await canComment(publicReq, expense)).to.be.false;
      expect(await canComment(randomUserReq, expense)).to.be.false;
      expect(await canComment(collectiveAdminReq, expense)).to.be.true;
      expect(await canComment(hostAdminReq, expense)).to.be.true;
      expect(await canComment(expenseOwnerReq, expense)).to.be.true;
      expect(await canComment(limitedHostAdminReq, expense)).to.be.false;
      expect(await canComment(collectiveAccountantReq, expense)).to.be.false;
      expect(await canComment(hostAccountantReq, expense)).to.be.false;
    });
  });

  describe('canUnschedulePayment', () => {
    it('only if scheduled for payment', async () => {
      await expense.update({ status: 'PENDING' });
      expect(await canUnschedulePayment(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'APPROVED' });
      expect(await canUnschedulePayment(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'PROCESSING' });
      expect(await canUnschedulePayment(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canUnschedulePayment(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canUnschedulePayment(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canUnschedulePayment(hostAdminReq, expense)).to.be.false;
      await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
      expect(await canUnschedulePayment(hostAdminReq, expense)).to.be.true;
    });

    it('only with the allowed roles', async () => {
      await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
      expect(await canUnschedulePayment(publicReq, expense)).to.be.false;
      expect(await canUnschedulePayment(randomUserReq, expense)).to.be.false;
      expect(await canUnschedulePayment(collectiveAdminReq, expense)).to.be.false;
      expect(await canUnschedulePayment(hostAdminReq, expense)).to.be.true;
      expect(await canUnschedulePayment(expenseOwnerReq, expense)).to.be.false;
      expect(await canUnschedulePayment(limitedHostAdminReq, expense)).to.be.false;
      expect(await canUnschedulePayment(collectiveAccountantReq, expense)).to.be.false;
      expect(await canUnschedulePayment(hostAccountantReq, expense)).to.be.false;
    });

    it('make sure legal name is validated against the account holder name', async () => {
      expect(isAccountHolderNameAndLegalNameMatch('Evil Corp, Inc', 'Evil Corp, Inc.')).to.be.true;
      expect(isAccountHolderNameAndLegalNameMatch('François', 'Francois')).to.be.true;
      expect(isAccountHolderNameAndLegalNameMatch('Sudharaka Palamakumbura', 'Palamakumbura Sudharaka')).to.be.true;
      expect(isAccountHolderNameAndLegalNameMatch('Sudharaka', 'Palamakumbura Sudharaka')).to.be.false;
      expect(isAccountHolderNameAndLegalNameMatch('Evil Corp, Inc', 'Evil Corp, Inc.')).to.be.true;
      expect(isAccountHolderNameAndLegalNameMatch('Evil Corp Inc', 'Evil Corp, Inc.')).to.be.true;
      expect(isAccountHolderNameAndLegalNameMatch(' Evil   Corp,    Inc.', '   Evil Corp   Inc')).to.be.true;
      expect(isAccountHolderNameAndLegalNameMatch('François Dêaccènt', 'Francois DeAccEnt')).to.be.true;
      expect(isAccountHolderNameAndLegalNameMatch('Sudharaka Palamakumbura', 'Palamakumbura Sudharaka')).to.be.true;
      expect(isAccountHolderNameAndLegalNameMatch('Sudharaka Palamakumbura', 'Sudharaka Palamakumbura')).to.be.true;
      expect(isAccountHolderNameAndLegalNameMatch('JHipster Inc.', 'JHipster Inc. 501(c)(3)')).to.be.true;
      expect(isAccountHolderNameAndLegalNameMatch('JHipster Inc. 501(c)(3)', 'JHipster Inc.')).to.be.true;
    });
  });

  describe('getExpenseAmountInDifferentCurrency', () => {
    describe('Wise', async () => {
      it('returns the amount in expense currency', async () => {
        const payoutMethod = await fakePayoutMethod({ service: 'TRANSFERWISE', type: 'BANK_ACCOUNT' });
        const expense = await fakeExpense({ PayoutMethodId: payoutMethod.id, amount: 1000, currency: 'EUR' });
        const amount = await getExpenseAmountInDifferentCurrency(expense, 'EUR', publicReq);
        expect(amount).to.deep.eq({
          value: 1000,
          currency: 'EUR',
          exchangeRate: null,
        });
      });

      describe('converts the amount to collective currency', () => {
        let expense;

        before(async () => {
          const payoutMethod = await fakePayoutMethod({ service: 'TRANSFERWISE', type: 'BANK_ACCOUNT' });
          const collective = await fakeCollective({ currency: 'USD' });
          expense = await fakeExpense({
            PayoutMethodId: payoutMethod.id,
            CollectiveId: collective.id,
            amount: 1000,
            currency: 'EUR',
          });
        });

        it('when there is no data (uses the mocked 1.1)', async () => {
          const amount = await getExpenseAmountInDifferentCurrency(expense, 'USD', publicReq);
          expect(amount).to.deep.eq({
            value: 1100,
            currency: 'USD',
            exchangeRate: {
              date: amount.exchangeRate.date, // We don't really care about the date
              fromCurrency: 'EUR',
              isApproximate: true,
              source: 'OPENCOLLECTIVE',
              toCurrency: 'USD',
              value: 1.1,
            },
          });
        });

        it('when there is data', async () => {
          await expense.update({
            data: {
              transfer: {
                sourceCurrency: 'USD', // Host currency
                targetCurrency: 'EUR', // Expense/Payout method currency
                rate: 1.4,
              },
            },
          });

          const amount = await getExpenseAmountInDifferentCurrency(expense, 'USD', publicReq);
          expect(amount).to.deep.eq({
            value: 714, // 1 * (1 / 1.4)
            currency: 'USD',
            exchangeRate: {
              date: amount.exchangeRate.date, // We don't really care about the date
              fromCurrency: 'EUR',
              isApproximate: true,
              source: 'WISE',
              toCurrency: 'USD',
              value: 1 / 1.4,
            },
          });
        });
      });
    });

    describe('PayPal', async () => {
      let expense;

      before(async () => {
        const payoutMethod = await fakePayoutMethod({ service: 'PAYPAL', type: 'PAYPAL' });
        const collective = await fakeCollective({ currency: 'USD' });
        expense = await fakeExpense({
          PayoutMethodId: payoutMethod.id,
          CollectiveId: collective.id,
          amount: 1000,
          currency: 'EUR',
        });
      });

      describe('converts the amount to collective currency', () => {
        it('when there is no data (uses the mocked 1.1)', async () => {
          const amount = await getExpenseAmountInDifferentCurrency(expense, 'USD', publicReq);
          expect(amount).to.deep.eq({
            value: 1100,
            currency: 'USD',
            exchangeRate: {
              date: amount.exchangeRate.date, // We don't really care about the date
              fromCurrency: 'EUR',
              isApproximate: true,
              source: 'OPENCOLLECTIVE',
              toCurrency: 'USD',
              value: 1.1,
            },
          });
        });

        it('when there is data', async () => {
          await expense.update({
            data: {
              /* eslint-disable camelcase */
              currency_conversion: {
                from_amount: { currency: 'EUR', value: 1000 },
                to_amount: { currency: 'USD', value: 1600 },
                exchange_rate: 1.6,
              },
              /* eslint-enable camelcase */
            },
          });

          const amount = await getExpenseAmountInDifferentCurrency(expense, 'USD', publicReq);
          expect(amount).to.deep.eq({
            value: 1600,
            currency: 'USD',
            exchangeRate: {
              date: amount.exchangeRate.date, // We don't really care about the date
              fromCurrency: 'EUR',
              isApproximate: true,
              source: 'PAYPAL',
              toCurrency: 'USD',
              value: 1.6,
            },
          });
        });
      });
    });
  });
});

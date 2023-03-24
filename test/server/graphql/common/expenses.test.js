import { expect } from 'chai';
import { cloneDeep } from 'lodash';
import moment from 'moment';

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
  checkHasBalanceToPayExpense,
  getExpenseAmountInDifferentCurrency,
  isAccountHolderNameAndLegalNameMatch,
} from '../../../../server/graphql/common/expenses';
import { createTransactionsFromPaidExpense } from '../../../../server/lib/transactions';
import models from '../../../../server/models';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeCurrencyExchangeRate,
  fakeExpense,
  fakeHost,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
} from '../../../test-helpers/fake-data';
import { getApolloErrorCode, makeRequest } from '../../../utils';

describe('server/graphql/common/expenses', () => {
  const contextShape = {
    expense: null,
    collective: null,
    host: null,
    collectiveAdmin: null,
    req: {
      public: null,
      randomUser: null,
      collectiveAdmin: null,
      collectiveAccountant: null,
      hostAdmin: null,
      hostAccountant: null,
      limitedHostAdmin: null,
      expenseOwner: null,
    },
  };

  const contexts = {
    normal: cloneDeep(contextShape),
    virtualCard: cloneDeep(contextShape),
    hostWithSpecialExpensePermissions: cloneDeep(contextShape),
  };

  const prepareContext = async () => {
    const randomUser = await fakeUser();
    const collectiveAdmin = await fakeUser();
    const collectiveAccountant = await fakeUser();
    const hostAdmin = await fakeUser();
    const hostAccountant = await fakeUser();
    const limitedHostAdmin = await fakeUser();
    const expenseOwner = await fakeUser();
    const payoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.OTHER });
    const collective = await fakeCollective();
    const expense = await fakeExpense({
      CollectiveId: collective.id,
      FromCollectiveId: expenseOwner.CollectiveId,
      PayoutMethodId: payoutMethod.id,
    });
    await collective.addUserWithRole(collectiveAdmin, 'ADMIN');
    await collective.addUserWithRole(collectiveAccountant, 'ACCOUNTANT');
    await collective.host.addUserWithRole(hostAdmin, 'ADMIN');
    await collective.host.addUserWithRole(hostAccountant, 'ACCOUNTANT');

    await Promise.all(
      [
        randomUser,
        collectiveAdmin,
        collectiveAccountant,
        hostAdmin,
        hostAccountant,
        limitedHostAdmin,
        expenseOwner,
      ].map(u => u.populateRoles()),
    );

    await limitedHostAdmin.update({ data: { features: { ALL: false } } });

    return {
      expense,
      collective,
      host: collective.host,
      collectiveAdmin,
      req: {
        public: makeRequest(),
        randomUser: makeRequest(randomUser),
        collectiveAdmin: makeRequest(collectiveAdmin),
        hostAdmin: makeRequest(hostAdmin),
        limitedHostAdmin: makeRequest(limitedHostAdmin),
        expenseOwner: makeRequest(expenseOwner),
        collectiveAccountant: makeRequest(collectiveAccountant),
        hostAccountant: makeRequest(hostAccountant),
      },
    };
  };

  before(async () => {
    contexts.normal = await prepareContext();

    contexts.virtualCard = await prepareContext();
    await contexts.virtualCard.expense.update({ type: 'CHARGE' });

    contexts.hostWithSpecialExpensePermissions = await prepareContext();
    const updatedHostSettings = { allowCollectiveAdminsToEditPrivateExpenseData: true };
    const updatedHost = await contexts.hostWithSpecialExpensePermissions.host.update({ settings: updatedHostSettings });
    contexts.hostWithSpecialExpensePermissions.collective.host = updatedHost;
    contexts.hostWithSpecialExpensePermissions.expense.collective.host = updatedHost;
  });

  /** A helper to run the same test on all contexts, to make sure they behave the same way */
  const runForAllContexts = async (fn, options = {}) => {
    for (const key in contexts) {
      if (contexts[key] !== options.except) {
        await fn(contexts[key]);
      }
    }
  };

  describe('canSeeExpenseAttachments', () => {
    it('can see only with the allowed roles or host admin', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
        expect(await canSeeExpenseAttachments(req.public, expense)).to.be.false;
        expect(await canSeeExpenseAttachments(req.randomUser, expense)).to.be.false;
        expect(await canSeeExpenseAttachments(req.collectiveAdmin, expense)).to.be.true;
        expect(await canSeeExpenseAttachments(req.collectiveAccountant, expense)).to.be.true;
        expect(await canSeeExpenseAttachments(req.hostAdmin, expense)).to.be.true;
        expect(await canSeeExpenseAttachments(req.hostAccountant, expense)).to.be.true;
        expect(await canSeeExpenseAttachments(req.expenseOwner, expense)).to.be.true;
        expect(await canSeeExpenseAttachments(req.limitedHostAdmin, expense)).to.be.false;
      });
    });
  });

  describe('canSeeExpensePayoutMethod', () => {
    it('can see only with the allowed roles', async () => {
      const { expense, req } = contexts.normal;
      expect(await canSeeExpensePayoutMethod(req.public, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(req.randomUser, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(req.collectiveAdmin, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(req.collectiveAccountant, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(req.hostAdmin, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(req.hostAccountant, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(req.expenseOwner, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(req.limitedHostAdmin, expense)).to.be.false;
    });

    it('collective admins can see the payout method for virtual cards', async () => {
      const { expense, req } = contexts.virtualCard;
      expect(await canSeeExpensePayoutMethod(req.public, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(req.randomUser, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(req.collectiveAdmin, expense)).to.be.true; // <-- Here
      expect(await canSeeExpensePayoutMethod(req.collectiveAccountant, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(req.hostAdmin, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(req.hostAccountant, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(req.expenseOwner, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(req.limitedHostAdmin, expense)).to.be.false;
    });

    it('can see the payout method for hosts that allow admins to edit private expense data', async () => {
      const { expense, req } = contexts.hostWithSpecialExpensePermissions;
      expect(await canSeeExpensePayoutMethod(req.public, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(req.randomUser, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(req.collectiveAdmin, expense)).to.be.true; // <-- Here
      expect(await canSeeExpensePayoutMethod(req.collectiveAccountant, expense)).to.be.false;
      expect(await canSeeExpensePayoutMethod(req.hostAdmin, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(req.hostAccountant, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(req.expenseOwner, expense)).to.be.true;
      expect(await canSeeExpensePayoutMethod(req.limitedHostAdmin, expense)).to.be.false;
    });
  });

  describe('canSeeExpenseInvoiceInfo', () => {
    it('can see only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
        expect(await canSeeExpenseInvoiceInfo(req.public, expense)).to.be.false;
        expect(await canSeeExpenseInvoiceInfo(req.randomUser, expense)).to.be.false;
        expect(await canSeeExpenseInvoiceInfo(req.collectiveAdmin, expense)).to.be.true;
        expect(await canSeeExpenseInvoiceInfo(req.collectiveAccountant, expense)).to.be.true;
        expect(await canSeeExpenseInvoiceInfo(req.hostAdmin, expense)).to.be.true;
        expect(await canSeeExpenseInvoiceInfo(req.hostAccountant, expense)).to.be.true;
        expect(await canSeeExpenseInvoiceInfo(req.expenseOwner, expense)).to.be.true;
        expect(await canSeeExpenseInvoiceInfo(req.limitedHostAdmin, expense)).to.be.false;
      });
    });
  });

  describe('canSeeExpensePayeeLocation', () => {
    it('can see only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
        expect(await canSeeExpensePayeeLocation(req.public, expense)).to.be.false;
        expect(await canSeeExpensePayeeLocation(req.randomUser, expense)).to.be.false;
        expect(await canSeeExpensePayeeLocation(req.collectiveAdmin, expense)).to.be.true;
        expect(await canSeeExpensePayeeLocation(req.collectiveAccountant, expense)).to.be.true;
        expect(await canSeeExpensePayeeLocation(req.hostAdmin, expense)).to.be.true;
        expect(await canSeeExpensePayeeLocation(req.hostAccountant, expense)).to.be.true;
        expect(await canSeeExpensePayeeLocation(req.expenseOwner, expense)).to.be.true;
        expect(await canSeeExpensePayeeLocation(req.limitedHostAdmin, expense)).to.be.false;
      });
    });
  });

  describe('canEditExpense', () => {
    it('only if not processing, paid or scheduled for payment', async () => {
      const { expense, req } = contexts.normal;
      await expense.update({ status: 'PENDING' });
      expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'APPROVED' });
      expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'ERROR' });
      expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'REJECTED' });
      expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'PROCESSING' });
      expect(await canEditExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canEditExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'DRAFT' });
      expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
      expect(await canEditExpense(req.hostAdmin, expense)).to.be.false;
    });

    it('can edit expense if user is the draft payee', async () => {
      const { expense } = contexts.normal;
      const expensePayee = await fakeUser();
      await expensePayee.populateRoles();
      await expense.update({ status: 'DRAFT', data: { payee: { id: expensePayee.collective.id } } });
      expect(await canEditExpense(makeRequest(expensePayee), expense)).to.be.true;
    });

    it('only with the allowed roles', async () => {
      const { expense, req } = contexts.normal;
      await expense.update({ status: 'REJECTED' });
      expect(await canEditExpense(req.public, expense)).to.be.false;
      expect(await canEditExpense(req.randomUser, expense)).to.be.false;
      expect(await canEditExpense(req.collectiveAdmin, expense)).to.be.false;
      expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
      expect(await canEditExpense(req.collectiveAccountant, expense)).to.be.false;
      expect(await canEditExpense(req.hostAccountant, expense)).to.be.false;
      expect(await canEditExpense(req.expenseOwner, expense)).to.be.true;
      expect(await canEditExpense(req.limitedHostAdmin, expense)).to.be.false;
    });

    it('can edit expense if collective admin and expense is a virtual card', async () => {
      const { expense, req } = contexts.virtualCard;
      await expense.update({ status: 'PENDING' });
      expect(await canEditExpense(req.public, expense)).to.be.false;
      expect(await canEditExpense(req.randomUser, expense)).to.be.false;
      expect(await canEditExpense(req.collectiveAdmin, expense)).to.be.true; // <-- Here
      expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
      expect(await canEditExpense(req.collectiveAccountant, expense)).to.be.false;
      expect(await canEditExpense(req.hostAccountant, expense)).to.be.false;
      expect(await canEditExpense(req.expenseOwner, expense)).to.be.true;
      expect(await canEditExpense(req.limitedHostAdmin, expense)).to.be.false;
    });

    it('can edit expense if host has special permission flag', async () => {
      const { expense, req } = contexts.hostWithSpecialExpensePermissions;
      await expense.update({ status: 'PENDING' });
      expect(await canEditExpense(req.public, expense)).to.be.false;
      expect(await canEditExpense(req.randomUser, expense)).to.be.false;
      expect(await canEditExpense(req.collectiveAdmin, expense)).to.be.true; // <-- Here
      expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
      expect(await canEditExpense(req.collectiveAccountant, expense)).to.be.false;
      expect(await canEditExpense(req.hostAccountant, expense)).to.be.false;
      expect(await canEditExpense(req.expenseOwner, expense)).to.be.true;
      expect(await canEditExpense(req.limitedHostAdmin, expense)).to.be.false;
    });
  });

  describe('canEditExpenseTags', () => {
    it('only if not processing, paid, draft or scheduled for payment', async () => {
      const { expense, req } = contexts.normal;

      // Can always edit tags if collective admin
      for (const status of Object.values(expenseStatus)) {
        await expense.update({ status });
        expect(await canEditExpenseTags(req.hostAdmin, expense)).to.be.true;
      }

      // But owner can't update them if it's paid
      await expense.update({ status: 'PAID' });
      expect(await canEditExpenseTags(req.expenseOwner, expense)).to.be.false;
    });

    it('only with the allowed roles', async () => {
      const { expense, req } = contexts.normal;
      await expense.update({ status: 'PENDING' });
      expect(await canEditExpenseTags(req.public, expense)).to.be.false;
      expect(await canEditExpenseTags(req.randomUser, expense)).to.be.false;
      expect(await canEditExpenseTags(req.collectiveAdmin, expense)).to.be.true;
      expect(await canEditExpenseTags(req.hostAdmin, expense)).to.be.true;
      expect(await canEditExpenseTags(req.collectiveAccountant, expense)).to.be.false;
      expect(await canEditExpenseTags(req.hostAccountant, expense)).to.be.false;
      expect(await canEditExpenseTags(req.expenseOwner, expense)).to.be.true;
      expect(await canEditExpenseTags(req.limitedHostAdmin, expense)).to.be.false;
    });
  });

  describe('canDeleteExpense', () => {
    it('only if rejected', async () => {
      const { expense, req } = contexts.normal;
      await expense.update({ status: 'PENDING' });
      expect(await canDeleteExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'APPROVED' });
      expect(await canDeleteExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'PROCESSING' });
      expect(await canDeleteExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canDeleteExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canDeleteExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canDeleteExpense(req.hostAdmin, expense)).to.be.true;
    });

    it('only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
        await expense.update({ status: 'REJECTED' });
        expect(await canDeleteExpense(req.public, expense)).to.be.false;
        expect(await canDeleteExpense(req.randomUser, expense)).to.be.false;
        expect(await canDeleteExpense(req.collectiveAdmin, expense)).to.be.true;
        expect(await canDeleteExpense(req.hostAdmin, expense)).to.be.true;
        expect(await canDeleteExpense(req.expenseOwner, expense)).to.be.true;
        expect(await canDeleteExpense(req.limitedHostAdmin, expense)).to.be.false;
        expect(await canDeleteExpense(req.collectiveAccountant, expense)).to.be.false;
        expect(await canDeleteExpense(req.hostAccountant, expense)).to.be.false;
      });
    });
  });

  describe('canPayExpense', () => {
    it('only if approved or error', async () => {
      const { expense, req } = contexts.normal;
      await expense.update({ status: 'PENDING' });
      expect(await canPayExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'APPROVED' });
      expect(await canPayExpense(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'PROCESSING' });
      expect(await canPayExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canPayExpense(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'PAID' });
      expect(await canPayExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canPayExpense(req.hostAdmin, expense)).to.be.false;
    });

    it('only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
        await expense.update({ status: 'APPROVED' });
        expect(await canPayExpense(req.public, expense)).to.be.false;
        expect(await canPayExpense(req.randomUser, expense)).to.be.false;
        expect(await canPayExpense(req.collectiveAdmin, expense)).to.be.false;
        expect(await canPayExpense(req.hostAdmin, expense)).to.be.true;
        expect(await canPayExpense(req.expenseOwner, expense)).to.be.false;
        expect(await canPayExpense(req.limitedHostAdmin, expense)).to.be.false;
        expect(await canPayExpense(req.collectiveAccountant, expense)).to.be.false;
        expect(await canPayExpense(req.hostAccountant, expense)).to.be.false;
      });
    });
  });

  describe('canApprove', () => {
    it('only if pending or rejected', async () => {
      const { expense, req } = contexts.normal;
      await expense.update({ status: 'PENDING' });
      expect(await canApprove(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'APPROVED' });
      expect(await canApprove(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'PROCESSING' });
      expect(await canApprove(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canApprove(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canApprove(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canApprove(req.hostAdmin, expense)).to.be.true;
    });
    it('only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
        await expense.update({ status: 'PENDING' });
        expect(await canApprove(req.public, expense)).to.be.false;
        expect(await canApprove(req.randomUser, expense)).to.be.false;
        expect(await canApprove(req.collectiveAdmin, expense)).to.be.true;
        expect(await canApprove(req.hostAdmin, expense)).to.be.true;
        expect(await canApprove(req.expenseOwner, expense)).to.be.false;
        expect(await canApprove(req.limitedHostAdmin, expense)).to.be.false;
        expect(await canApprove(req.collectiveAccountant, expense)).to.be.false;
        expect(await canApprove(req.hostAccountant, expense)).to.be.false;
      });
    });

    it('throws informative error if options.throw is set', async () => {
      const { expense, req } = contexts.normal;
      await expense.update({ status: 'PENDING' });
      expect(await getApolloErrorCode(canApprove(req.public, expense, { throw: true }))).to.be.equal(
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE,
      );
      expect(await getApolloErrorCode(canApprove(req.expenseOwner, expense, { throw: true }))).to.be.equal(
        EXPENSE_PERMISSION_ERROR_CODES.MINIMAL_CONDITION_NOT_MET,
      );

      await expense.update({ status: 'APPROVED' });
      expect(await getApolloErrorCode(canApprove(req.public, expense, { throw: true }))).to.be.equal(
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    });

    describe('enforces EXPENSE_AUTHOR_CANNOT_APPROVE policy', () => {
      let newExpense;
      before(async () => {
        const { expense, collective, collectiveAdmin } = contexts.normal;
        const payoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.OTHER });
        newExpense = await fakeExpense({
          CollectiveId: collective.id,
          FromCollectiveId: collectiveAdmin.CollectiveId,
          PayoutMethodId: payoutMethod.id,
          UserId: collectiveAdmin.id,
        });

        await expense.update({ status: 'PENDING' });
      });

      beforeEach(async () => {
        const { collective } = contexts.normal;
        await collective.host.setPolicies({
          [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: false, amountInCents: 0 },
        });
        await collective.setPolicies({
          [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: false, amountInCents: 0 },
        });
        await newExpense.update({ amount: 10e2 });
      });

      it('by collective', async () => {
        const { collective, req } = contexts.normal;
        newExpense.collective = await collective.setPolicies({
          [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true, amountInCents: 0 },
        });
        expect(await getApolloErrorCode(canApprove(req.collectiveAdmin, newExpense, { throw: true }))).to.be.equal(
          EXPENSE_PERMISSION_ERROR_CODES.AUTHOR_CANNOT_APPROVE,
        );
        expect(await canApprove(req.collectiveAdmin, newExpense)).to.be.false;

        newExpense.collective = await collective.setPolicies({
          [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true, amountInCents: 20e2 },
        });

        expect(await canApprove(req.collectiveAdmin, newExpense)).to.be.true;

        await newExpense.update({ amount: 20e2 });

        expect(await getApolloErrorCode(canApprove(req.collectiveAdmin, newExpense, { throw: true }))).to.be.equal(
          EXPENSE_PERMISSION_ERROR_CODES.AUTHOR_CANNOT_APPROVE,
        );
        expect(await canApprove(req.collectiveAdmin, newExpense)).to.be.false;
      });

      it('by host', async () => {
        const { req, collective } = contexts.normal;
        await collective.setPolicies({
          [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: false, amountInCents: 0 },
        });
        collective.host = await collective.host.setPolicies({
          [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: {
            enabled: true,
            amountInCents: 0,
            appliesToHostedCollectives: true,
          },
        });
        newExpense.collective = collective;

        expect(await canApprove(req.collectiveAdmin, newExpense)).to.be.true;

        newExpense.collective.host = await collective.host.setPolicies({
          [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: {
            enabled: true,
            amountInCents: 0,
            appliesToHostedCollectives: true,
            appliesToSingleAdminCollectives: true,
          },
        });

        expect(await getApolloErrorCode(canApprove(req.collectiveAdmin, newExpense, { throw: true }))).to.be.equal(
          EXPENSE_PERMISSION_ERROR_CODES.AUTHOR_CANNOT_APPROVE,
        );
        expect(await canApprove(req.collectiveAdmin, newExpense)).to.be.false;

        newExpense.collective.host = await collective.host.setPolicies({
          [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: {
            enabled: true,
            amountInCents: 20e2,
            appliesToHostedCollectives: true,
            appliesToSingleAdminCollectives: true,
          },
        });

        expect(await canApprove(req.collectiveAdmin, newExpense)).to.be.true;

        await newExpense.update({ amount: 20e2 });

        expect(await getApolloErrorCode(canApprove(req.collectiveAdmin, newExpense, { throw: true }))).to.be.equal(
          EXPENSE_PERMISSION_ERROR_CODES.AUTHOR_CANNOT_APPROVE,
        );
        expect(await canApprove(req.collectiveAdmin, newExpense)).to.be.false;
      });
    });
  });

  describe('canReject', () => {
    it('only if pending', async () => {
      const { expense, req } = contexts.normal;
      await expense.update({ status: 'PENDING' });
      expect(await canReject(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'APPROVED' });
      expect(await canReject(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'PROCESSING' });
      expect(await canReject(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canReject(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canReject(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canReject(req.hostAdmin, expense)).to.be.false;
    });

    it('only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
        await expense.update({ status: 'PENDING' });
        expect(await canReject(req.public, expense)).to.be.false;
        expect(await canReject(req.randomUser, expense)).to.be.false;
        expect(await canReject(req.collectiveAdmin, expense)).to.be.true;
        expect(await canReject(req.hostAdmin, expense)).to.be.true;
        expect(await canReject(req.expenseOwner, expense)).to.be.false;
        expect(await canReject(req.limitedHostAdmin, expense)).to.be.false;
        expect(await canReject(req.collectiveAccountant, expense)).to.be.false;
        expect(await canReject(req.hostAccountant, expense)).to.be.false;
      });
    });
  });

  describe('canUnapprove', () => {
    it('only if approved', async () => {
      const { expense, req } = contexts.normal;
      await expense.update({ status: 'PENDING' });
      expect(await canUnapprove(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'APPROVED' });
      expect(await canUnapprove(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'PROCESSING' });
      expect(await canUnapprove(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canUnapprove(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'PAID' });
      expect(await canUnapprove(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canUnapprove(req.hostAdmin, expense)).to.be.false;
    });

    it('only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
        await expense.update({ status: 'APPROVED' });
        expect(await canUnapprove(req.public, expense)).to.be.false;
        expect(await canUnapprove(req.randomUser, expense)).to.be.false;
        expect(await canUnapprove(req.collectiveAdmin, expense)).to.be.true;
        expect(await canUnapprove(req.hostAdmin, expense)).to.be.true;
        expect(await canUnapprove(req.expenseOwner, expense)).to.be.false;
        expect(await canUnapprove(req.limitedHostAdmin, expense)).to.be.false;
        expect(await canUnapprove(req.collectiveAccountant, expense)).to.be.false;
        expect(await canUnapprove(req.hostAccountant, expense)).to.be.false;
      });
    });
  });

  describe('canMarkAsUnpaid', () => {
    it('only if paid', async () => {
      const { expense, req } = contexts.normal;
      await expense.update({ status: 'PENDING' });
      expect(await canMarkAsUnpaid(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'APPROVED' });
      expect(await canMarkAsUnpaid(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'PROCESSING' });
      expect(await canMarkAsUnpaid(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canMarkAsUnpaid(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canMarkAsUnpaid(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'REJECTED' });
      expect(await canMarkAsUnpaid(req.hostAdmin, expense)).to.be.false;
    });

    it('only with the allowed roles', async () => {
      await runForAllContexts(
        async context => {
          const { expense, req } = context;
          await expense.update({ status: 'PAID' });
          expect(await canMarkAsUnpaid(req.public, expense)).to.be.false;
          expect(await canMarkAsUnpaid(req.randomUser, expense)).to.be.false;
          expect(await canMarkAsUnpaid(req.collectiveAdmin, expense)).to.be.false;
          expect(await canMarkAsUnpaid(req.hostAdmin, expense)).to.be.true;
          expect(await canMarkAsUnpaid(req.expenseOwner, expense)).to.be.false;
          expect(await canMarkAsUnpaid(req.limitedHostAdmin, expense)).to.be.false;
          expect(await canMarkAsUnpaid(req.collectiveAccountant, expense)).to.be.false;
          expect(await canMarkAsUnpaid(req.hostAccountant, expense)).to.be.false;
        },
        { except: contexts.virtualCard },
      );
    });

    it('not if the expense is a virtual card', async () => {
      const { expense, req } = contexts.virtualCard;
      await expense.update({ status: 'PAID' });
      for (const userReq of Object.values(req)) {
        expect(await canMarkAsUnpaid(userReq, expense)).to.be.false;
      }
    });
  });

  describe('canComment', () => {
    it('only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
        await expense.update({ status: 'PAID' });
        expect(await canComment(req.public, expense)).to.be.false;
        expect(await canComment(req.randomUser, expense)).to.be.false;
        expect(await canComment(req.collectiveAdmin, expense)).to.be.true;
        expect(await canComment(req.hostAdmin, expense)).to.be.true;
        expect(await canComment(req.expenseOwner, expense)).to.be.true;
        expect(await canComment(req.limitedHostAdmin, expense)).to.be.false;
        expect(await canComment(req.collectiveAccountant, expense)).to.be.true;
        expect(await canComment(req.hostAccountant, expense)).to.be.true;
      });
    });
  });

  describe('canUnschedulePayment', () => {
    it('only if scheduled for payment', async () => {
      const { expense, req } = contexts.normal;
      await expense.update({ status: 'PENDING' });
      expect(await canUnschedulePayment(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'APPROVED' });
      expect(await canUnschedulePayment(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'PROCESSING' });
      expect(await canUnschedulePayment(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canUnschedulePayment(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canUnschedulePayment(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canUnschedulePayment(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
      expect(await canUnschedulePayment(req.hostAdmin, expense)).to.be.true;
    });

    it('only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
        await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
        expect(await canUnschedulePayment(req.public, expense)).to.be.false;
        expect(await canUnschedulePayment(req.randomUser, expense)).to.be.false;
        expect(await canUnschedulePayment(req.collectiveAdmin, expense)).to.be.false;
        expect(await canUnschedulePayment(req.hostAdmin, expense)).to.be.true;
        expect(await canUnschedulePayment(req.expenseOwner, expense)).to.be.false;
        expect(await canUnschedulePayment(req.limitedHostAdmin, expense)).to.be.false;
        expect(await canUnschedulePayment(req.collectiveAccountant, expense)).to.be.false;
        expect(await canUnschedulePayment(req.hostAccountant, expense)).to.be.false;
      });
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
    describe('Wise', () => {
      it('returns the amount in expense currency', async () => {
        const payoutMethod = await fakePayoutMethod({ service: 'TRANSFERWISE', type: 'BANK_ACCOUNT' });
        const expense = await fakeExpense({ PayoutMethodId: payoutMethod.id, amount: 1000, currency: 'EUR' });
        const amount = await getExpenseAmountInDifferentCurrency(expense, 'EUR', contexts.normal.req.public);
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
          const amount = await getExpenseAmountInDifferentCurrency(expense, 'USD', contexts.normal.req.public);
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

          const amount = await getExpenseAmountInDifferentCurrency(expense, 'USD', contexts.normal.req.public);
          expect(amount).to.deep.eq({
            value: 714, // 1 * (1 / 1.4)
            currency: 'USD',
            exchangeRate: {
              date: amount.exchangeRate.date, // We don't really care about the date
              fromCurrency: 'EUR',
              isApproximate: false,
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
          const amount = await getExpenseAmountInDifferentCurrency(expense, 'USD', contexts.normal.req.public);
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

          const amount = await getExpenseAmountInDifferentCurrency(expense, 'USD', contexts.normal.req.public);
          expect(amount).to.deep.eq({
            value: 1600,
            currency: 'USD',
            exchangeRate: {
              date: amount.exchangeRate.date, // We don't really care about the date
              fromCurrency: 'EUR',
              isApproximate: false,
              source: 'PAYPAL',
              toCurrency: 'USD',
              value: 1.6,
            },
          });
        });
      });
    });

    describe('Manual', async () => {
      let expense;

      before(async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
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
          const amount = await getExpenseAmountInDifferentCurrency(expense, 'USD', contexts.normal.req.public);
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

        it('when there is a transaction to retrieve the rate', async () => {
          await createTransactionsFromPaidExpense(expense.collective.host, expense, undefined, 1.6);
          await expense.update({ status: 'PAID' });

          const amount = await getExpenseAmountInDifferentCurrency(expense, 'USD', contexts.normal.req.public);
          expect(amount).to.deep.eq({
            value: 1600,
            currency: 'USD',
            exchangeRate: {
              date: amount.exchangeRate.date, // We don't really care about the date
              fromCurrency: 'EUR',
              isApproximate: false,
              source: 'OPENCOLLECTIVE',
              toCurrency: 'USD',
              value: 1.6,
            },
          });
        });
      });
    });
  });

  describe('checkHasBalanceToPayExpense', () => {
    let host, collective, payoutMethod;
    before(async () => {
      host = await fakeHost({ currency: 'USD' });
      collective = await fakeCollective({ currency: 'USD', HostCollectiveId: host.id });
      payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
      await fakeTransaction({
        type: 'CREDIT',
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: 1000 * 100,
      });
      await models.CurrencyExchangeRate.destroy({ where: { to: ['BRL', 'EUR'] } });
      await Promise.all([
        fakeCurrencyExchangeRate({ from: 'USD', to: 'BRL', rate: 5.0, createdAt: moment().subtract(3, 'days') }),
        fakeCurrencyExchangeRate({ from: 'USD', to: 'BRL', rate: 5.1, createdAt: moment().subtract(2, 'days') }),
        fakeCurrencyExchangeRate({ from: 'USD', to: 'BRL', rate: 5.2, createdAt: moment().subtract(1, 'days') }),
        fakeCurrencyExchangeRate({ from: 'USD', to: 'BRL', rate: 5.1, createdAt: moment() }),
        fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR', rate: 1, createdAt: moment().subtract(3, 'days') }),
        fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR', rate: 1.1, createdAt: moment().subtract(2, 'days') }),
        fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR', rate: 1.15, createdAt: moment().subtract(1, 'days') }),
        fakeCurrencyExchangeRate({ from: 'USD', to: 'EUR', rate: 1.05, createdAt: moment() }),
      ]);
    });

    it('throws if the collective has not enough balance to cover for the expense', async () => {
      const expense = await fakeExpense({
        currency: 'USD',
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        PayoutMethodId: payoutMethod.id,
        FromCollectiveId: payoutMethod.CollectiveId,
        amount: 100001,
      });

      await expect(checkHasBalanceToPayExpense(host, expense, payoutMethod)).to.be.rejectedWith(
        'Collective does not have enough funds to pay this expense. Current balance: $1,000.00, Expense amount: $1,000.01',
      );
    });

    it('throws if the collective has not enough balance to cover for the exchange rate variance', async () => {
      let expense = await fakeExpense({
        currency: 'BRL',
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        PayoutMethodId: payoutMethod.id,
        FromCollectiveId: payoutMethod.CollectiveId,
        amount: 500000,
      });

      await expect(checkHasBalanceToPayExpense(host, expense, payoutMethod)).to.be.rejectedWith(
        'Collective does not have enough funds to pay this expense. Current balance: $1,000.00, Expense amount: R$5,000.00. For expenses submitted in a different currency than the collective, an error margin is applied to accommodate for fluctuations. The maximum amount that can be paid is R$4,936.70',
      );

      expense = await fakeExpense({
        currency: 'EUR',
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        PayoutMethodId: payoutMethod.id,
        FromCollectiveId: payoutMethod.CollectiveId,
        amount: 500000,
      });

      await expect(checkHasBalanceToPayExpense(host, expense, payoutMethod)).to.be.rejectedWith(
        'Collective does not have enough funds to pay this expense. Current balance: $1,000.00, Expense amount: €5,000.00. For expenses submitted in a different currency than the collective, an error margin is applied to accommodate for fluctuations. The maximum amount that can be paid is €920.90',
      );
    });
  });
});

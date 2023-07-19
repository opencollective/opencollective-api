import { expect } from 'chai';
import { cloneDeep } from 'lodash-es';
import moment from 'moment';

import { expenseStatus } from '../../../../server/constants/index.js';
import { EXPENSE_PERMISSION_ERROR_CODES } from '../../../../server/constants/permissions.js';
import POLICIES from '../../../../server/constants/policies.js';
import { allowContextPermission, PERMISSION_TYPE } from '../../../../server/graphql/common/context-permissions.js';
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
  canSeeExpenseDraftPrivateDetails,
  canSeeExpenseInvoiceInfo,
  canSeeExpensePayeeLocation,
  canSeeExpensePayoutMethod,
  canUnapprove,
  canUnschedulePayment,
  canVerifyDraftExpense,
  checkHasBalanceToPayExpense,
  getExpenseAmountInDifferentCurrency,
  isAccountHolderNameAndLegalNameMatch,
} from '../../../../server/graphql/common/expenses.js';
import { createTransactionsFromPaidExpense } from '../../../../server/lib/transactions.js';
import models from '../../../../server/models/index.js';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod.js';
import {
  fakeCollective,
  fakeCurrencyExchangeRate,
  fakeExpense,
  fakeHost,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
} from '../../../test-helpers/fake-data.js';
import { getApolloErrorCode, makeRequest } from '../../../utils.js';

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

  /**
   * Use this object to store different test contexts.
   * `runForAllContexts` will pick this to make sure test assertions check all contexts.
   */
  const contexts = {
    normal: cloneDeep(contextShape),
    selfHosted: cloneDeep(contextShape),
    virtualCard: cloneDeep(contextShape),
  };

  const prepareContext = async ({ host = undefined, collective = undefined } = {}) => {
    const randomUser = await fakeUser();
    const collectiveAdmin = await fakeUser();
    const collectiveAccountant = await fakeUser();
    const hostAdmin = await fakeUser();
    const hostAccountant = await fakeUser();
    const limitedHostAdmin = await fakeUser();
    const expenseOwner = await fakeUser();
    const payoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.OTHER });
    collective = collective || (await fakeCollective({ HostCollectiveId: host?.id }));
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
      isSelfHosted: collective.host.id === collective.id,
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
    // The most common pattern: a collective + fiscal host
    contexts.normal = await prepareContext();

    // Virtual card
    contexts.virtualCard = await prepareContext();
    await contexts.virtualCard.expense.update({ type: 'CHARGE' });

    // A self-hosted collective
    const selfHostedCollective = await fakeCollective({ isHostAccount: true, isActive: true, HostCollectiveId: null });
    await selfHostedCollective.update({ HostCollectiveId: selfHostedCollective.id });
    selfHostedCollective.host = selfHostedCollective;
    contexts.selfHosted = await prepareContext({ host: selfHostedCollective, collective: selfHostedCollective });
  });

  /** A helper to run the same test on all contexts, to make sure they behave the same way */
  const runForAllContexts = async (fn, options = {}) => {
    for (const key in contexts) {
      if (contexts[key] !== options.except) {
        try {
          await fn(contexts[key]);
        } catch (e) {
          // Add context information to error message
          e.message = `Error in context ${key}: ${e.message}`;
          throw e;
        }
      }
    }
  };

  const checkAllPermissions = async (fn, context) => {
    const { req, expense } = context;
    const promises = {};
    for (const key in req) {
      promises[key] = await Promise.resolve(fn(req[key], expense));
    }
    return promises;
  };

  describe('canSeeExpenseAttachments', () => {
    it('can see only with the allowed roles or host admin', async () => {
      await runForAllContexts(async context => {
        expect(await checkAllPermissions(canSeeExpenseAttachments, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          collectiveAccountant: true,
          hostAdmin: true,
          hostAccountant: true,
          limitedHostAdmin: false,
          expenseOwner: true,
        });
      });
    });
  });

  describe('canSeeExpensePayoutMethod', () => {
    it('can see only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        expect(await checkAllPermissions(canSeeExpensePayoutMethod, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          collectiveAccountant: context.isSelfHosted ? true : false,
          hostAdmin: true,
          hostAccountant: true,
          expenseOwner: true,
          limitedHostAdmin: false,
        });
      });
    });
  });

  describe('canSeeExpenseInvoiceInfo', () => {
    it('can see only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        expect(await checkAllPermissions(canSeeExpenseInvoiceInfo, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          collectiveAccountant: true,
          hostAdmin: true,
          hostAccountant: true,
          expenseOwner: true,
          limitedHostAdmin: false,
        });
      });
    });
  });

  describe('canSeeExpensePayeeLocation', () => {
    it('can see only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        expect(await checkAllPermissions(canSeeExpensePayeeLocation, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          collectiveAccountant: true,
          hostAdmin: true,
          hostAccountant: true,
          expenseOwner: true,
          limitedHostAdmin: false,
        });
      });
    });
  });

  describe('canSeeExpenseDraftPrivateDetails', () => {
    it('can see only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        expect(await checkAllPermissions(canSeeExpensePayeeLocation, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          collectiveAccountant: true,
          hostAdmin: true,
          hostAccountant: true,
          expenseOwner: true,
          limitedHostAdmin: false,
        });
      });
    });

    it('can see if context permission is set (in case user provided the correct draft key', async () => {
      // Using a new context to make sure we don't pollute another request's context
      const context = await prepareContext();
      const { req, expense } = context;
      allowContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_DRAFT_PRIVATE_DETAILS, expense.id);
      expect(await canSeeExpenseDraftPrivateDetails(req, expense)).to.be.true;
    });
  });

  describe('canEditExpense', () => {
    it('only if not processing, paid or scheduled for payment', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
        const isVirtualCard = expense.type === 'CHARGE';
        await expense.update({ status: 'PENDING' });
        expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
        await expense.update({ status: 'APPROVED' });
        expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
        await expense.update({ status: 'ERROR' });
        expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
        await expense.update({ status: 'REJECTED' });
        expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
        await expense.update({ status: 'PROCESSING' });

        // Can still edit processing/paid expenses if it's a virtual card
        if (isVirtualCard) {
          expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
          await expense.update({ status: 'PAID' });
          expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
        } else {
          expect(await canEditExpense(req.hostAdmin, expense)).to.be.false;
          await expense.update({ status: 'PAID' });
          expect(await canEditExpense(req.hostAdmin, expense)).to.be.false;
        }

        await expense.update({ status: 'DRAFT' });
        expect(await canEditExpense(req.hostAdmin, expense)).to.be.true;
        await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
        expect(await canEditExpense(req.hostAdmin, expense)).to.be.false;
      });
    });

    it('can edit virtual card charges', async () => {
      await contexts.virtualCard.expense.update({ status: 'PROCESSING' });
      expect(await checkAllPermissions(canEditExpense, contexts.virtualCard)).to.deep.equal({
        public: false,
        randomUser: false,
        collectiveAdmin: true,
        collectiveAccountant: false,
        hostAdmin: true,
        hostAccountant: false,
        expenseOwner: true,
        limitedHostAdmin: false,
      });
    });

    it('can edit expense if user is the draft payee', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        const expensePayee = await fakeUser();
        await expensePayee.populateRoles();
        await expense.update({ status: 'DRAFT', data: { payee: { id: expensePayee.collective.id } } });
        expect(await canEditExpense(makeRequest(expensePayee), expense)).to.be.true;
      });
    });

    it('only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        await context.expense.update({ status: 'REJECTED' });
        expect(await checkAllPermissions(canEditExpense, contexts.normal)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          collectiveAccountant: false,
          hostAdmin: true,
          hostAccountant: false,
          expenseOwner: true,
          limitedHostAdmin: false,
        });
      });
    });
  });

  describe('canEditExpenseTags', () => {
    it('only if not processing, paid, draft or scheduled for payment', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;

        // Can always edit tags if collective admin
        for (const status of Object.values(expenseStatus)) {
          await expense.update({ status });
          expect(await canEditExpenseTags(req.hostAdmin, expense)).to.be.true;
        }

        // But owner can't update them if it's paid
        await expense.update({ status: 'PAID' });
        expect(await canEditExpenseTags(req.expenseOwner, expense)).to.be.false;
      });
    });

    it('only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'PENDING' });
        expect(await checkAllPermissions(canEditExpenseTags, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          collectiveAccountant: false,
          hostAdmin: true,
          hostAccountant: false,
          expenseOwner: true,
          limitedHostAdmin: false,
        });
      });
    });
  });

  describe('canDeleteExpense', () => {
    it('only if rejected', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
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
    });

    it('only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'REJECTED' });
        expect(await checkAllPermissions(canDeleteExpense, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          collectiveAccountant: false,
          hostAdmin: true,
          hostAccountant: false,
          expenseOwner: true,
          limitedHostAdmin: false,
        });
      });
    });
  });

  describe('canPayExpense', () => {
    it('only if approved or error', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
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
    });

    it('only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'APPROVED' });
        expect(await checkAllPermissions(canPayExpense, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: context.isSelfHosted ? true : false,
          hostAdmin: true,
          expenseOwner: false,
          limitedHostAdmin: false,
          collectiveAccountant: false,
          hostAccountant: false,
        });
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
        const { expense } = context;
        await expense.update({ status: 'PENDING' });
        expect(await checkAllPermissions(canApprove, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          hostAdmin: true,
          expenseOwner: false,
          limitedHostAdmin: false,
          collectiveAccountant: false,
          hostAccountant: false,
        });
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
        const { expense } = context;
        await expense.update({ status: 'PENDING' });
        expect(await checkAllPermissions(canReject, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          hostAdmin: true,
          expenseOwner: false,
          limitedHostAdmin: false,
          collectiveAccountant: false,
          hostAccountant: false,
        });
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
        const { expense } = context;
        await expense.update({ status: 'APPROVED' });
        expect(await checkAllPermissions(canUnapprove, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          hostAdmin: true,
          expenseOwner: false,
          limitedHostAdmin: false,
          collectiveAccountant: false,
          hostAccountant: false,
        });
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
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'PAID' });
        const isVirtualCard = expense.type === 'CHARGE';
        expect(await checkAllPermissions(canMarkAsUnpaid, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: isVirtualCard ? false : context.isSelfHosted,
          hostAdmin: isVirtualCard ? false : true,
          expenseOwner: false,
          limitedHostAdmin: false,
          collectiveAccountant: false,
          hostAccountant: false,
        });
      });
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
        const { expense } = context;
        await expense.update({ status: 'PAID' });
        expect(await checkAllPermissions(canComment, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          hostAdmin: true,
          expenseOwner: true,
          limitedHostAdmin: false,
          collectiveAccountant: true,
          hostAccountant: true,
        });
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
        const { expense } = context;
        await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
        expect(await checkAllPermissions(canUnschedulePayment, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: context.isSelfHosted,
          hostAdmin: true,
          expenseOwner: false,
          limitedHostAdmin: false,
          collectiveAccountant: false,
          hostAccountant: false,
        });
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

  describe('canVerifyDraftExpense', () => {
    it('only if DRAFT/UNVERIFIED', async () => {
      const { expense, req } = contexts.normal;
      await expense.update({ status: 'DRAFT' });
      expect(await canVerifyDraftExpense(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'UNVERIFIED' });
      expect(await canVerifyDraftExpense(req.hostAdmin, expense)).to.be.true;
      await expense.update({ status: 'APPROVED' });
      expect(await canVerifyDraftExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'PROCESSING' });
      expect(await canVerifyDraftExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'ERROR' });
      expect(await canVerifyDraftExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'PAID' });
      expect(await canVerifyDraftExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'REJECTED' });
      expect(await canVerifyDraftExpense(req.hostAdmin, expense)).to.be.false;
      await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
      expect(await canVerifyDraftExpense(req.hostAdmin, expense)).to.be.false;
    });

    it('only with the allowed roles', async () => {
      await runForAllContexts(
        async context => {
          const { expense } = context;
          await expense.update({ status: 'DRAFT' });
          expect(await checkAllPermissions(canVerifyDraftExpense, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: true,
            hostAdmin: true,
            expenseOwner: true,
            limitedHostAdmin: false,
            collectiveAccountant: false,
            hostAccountant: false,
          });
        },
        {
          except: contexts.virtualCard,
        },
      );
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

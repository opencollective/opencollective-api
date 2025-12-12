import { expect } from 'chai';
import { cloneDeep } from 'lodash';
import moment from 'moment';

import { expenseStatus } from '../../../../server/constants';
import { EXPENSE_PERMISSION_ERROR_CODES } from '../../../../server/constants/permissions';
import POLICIES from '../../../../server/constants/policies';
import { allowContextPermission, PERMISSION_TYPE } from '../../../../server/graphql/common/context-permissions';
import {
  canApprove,
  canAttachReceipts,
  canComment,
  canDeleteExpense,
  canEditExpense,
  canEditExpenseTags,
  canEditItemDescription,
  canEditItems,
  canEditPaidBy,
  canEditPayee,
  canEditPayoutMethod,
  canEditTitle,
  canEditType,
  canMarkAsPaid,
  canMarkAsUnpaid,
  canPayExpense,
  canReject,
  canSeeDraftKey,
  canSeeExpenseAttachments,
  canSeeExpenseDraftPrivateDetails,
  canSeeExpenseInvoiceInfo,
  canSeeExpensePayeeLocation,
  canSeeExpensePayoutMethodPrivateDetails,
  canUnapprove,
  canUnschedulePayment,
  canVerifyDraftExpense,
  checkHasBalanceToPayExpense,
  getExpenseAmountInDifferentCurrency,
  isAccountHolderNameAndLegalNameMatch,
} from '../../../../server/graphql/common/expenses';
import { createTransactionsFromPaidExpense } from '../../../../server/lib/transactions';
import models, { Collective } from '../../../../server/models';
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
import { getApolloErrorCode, getOrCreatePlatformAccount, makeRequest, resetTestDB } from '../../../utils';

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
    manuallyCreatedVirtualCardCharge: cloneDeep(contextShape),
    settlement: cloneDeep(contextShape),
    platformBilling: cloneDeep(contextShape),
    collectiveWithSpecialPayoutPolicy: cloneDeep(contextShape),
  };

  const prepareContext = async ({ host = undefined, collective = undefined, name } = {}) => {
    const platformAdmin = await fakeUser();
    const platformCollective = await getOrCreatePlatformAccount();
    await platformCollective.addUserWithRole(platformAdmin, 'ADMIN');

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
      UserId: expenseOwner.id,
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
        platformAdmin,
      ].map(u => u.populateRoles()),
    );

    await limitedHostAdmin.update({ data: { features: { ALL: false } } });

    return {
      name,
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
        platformAdmin: makeRequest(platformAdmin),
      },
    };
  };

  before(async () => {
    await resetTestDB();
    const platform = await getOrCreatePlatformAccount();

    // The most common pattern: a collective + fiscal host
    contexts.normal = await prepareContext({ name: 'normal' });

    // Virtual card
    contexts.virtualCard = await prepareContext({ name: 'virtualCard' });
    await contexts.virtualCard.expense.update({ type: 'CHARGE' });

    // Manually created virtual card charge
    contexts.manuallyCreatedVirtualCardCharge = await prepareContext({ name: 'manuallyCreatedVirtualCardCharge' });
    await contexts.manuallyCreatedVirtualCardCharge.expense.update({
      type: 'CHARGE',
      data: { isManualVirtualCardCharge: true },
    });

    // A self-hosted collective
    const selfHostedCollective = await fakeCollective({ isHostAccount: true, isActive: true, HostCollectiveId: null });
    await selfHostedCollective.update({ HostCollectiveId: selfHostedCollective.id });
    selfHostedCollective.host = selfHostedCollective;
    contexts.selfHosted = await prepareContext({
      name: 'selfHosted',
      host: selfHostedCollective,
      collective: selfHostedCollective,
    });

    // A host with loose expense permissions
    contexts.collectiveWithSpecialPayoutPolicy = await prepareContext({ name: 'collectiveWithSpecialPayoutPolicy' });
    const updatedCollective = await contexts.collectiveWithSpecialPayoutPolicy.collective.update({
      data: { policies: { [POLICIES.COLLECTIVE_ADMINS_CAN_SEE_PAYOUT_METHODS]: true } },
    });
    contexts.collectiveWithSpecialPayoutPolicy.expense.collective = updatedCollective;

    contexts.settlement = await prepareContext({
      name: 'settlement',
    });
    await contexts.settlement.expense.update({
      type: 'SETTLEMENT',
      FromCollectiveId: platform.id,
    });
    contexts.settlement.expense.fromCollective = await Collective.findByPk(platform.id);

    contexts.platformBilling = await prepareContext({
      name: 'platformBilling',
    });

    await contexts.platformBilling.expense.update({
      type: 'PLATFORM_BILLING',
      FromCollectiveId: platform.id,
    });

    contexts.platformBilling.expense.fromCollective = platform;
  });

  beforeEach(async () => {
    await contexts.settlement.expense.update({ type: 'SETTLEMENT' });
    await contexts.virtualCard.expense.update({ type: 'CHARGE' });
    await contexts.platformBilling.expense.update({ type: 'PLATFORM_BILLING' });
    await contexts.manuallyCreatedVirtualCardCharge.expense.update({
      type: 'CHARGE',
      data: { isManualVirtualCardCharge: true },
    });
  });

  /**
   * A helper to run the same test on all contexts, to make sure they behave the same way
   * @param {(context: typeof contexts[keyof typeof contexts]) => Promise<void>} fn - The function to run for each context
   * @param {Partial<typeof contexts[keyof typeof contexts]>} options - The options to filter the contexts
   * @returns {Promise<void>}
   */
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

  /** A helper to run the same test on all contexts, to make sure they behave the same way */
  const runEachForAllContexts = (fn, options = {}) => {
    for (const key in contexts) {
      if (contexts[key] !== options.except) {
        fn(key);
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
    describe('can see only with the allowed roles or host admin', () => {
      runEachForAllContexts(key => {
        it(key, async () => {
          const context = contexts[key];
          expect(await checkAllPermissions(canSeeExpenseAttachments, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: true,
            collectiveAccountant: true,
            hostAdmin: true,
            hostAccountant: true,
            limitedHostAdmin: false,
            expenseOwner: true,
            platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
          });
        });
      });
    });
  });

  describe('canSeeExpensePayoutMethodPrivateDetails', () => {
    describe('can see only with the allowed roles', () => {
      runEachForAllContexts(key => {
        it(key, async () => {
          const context = contexts[key];
          expect(await checkAllPermissions(canSeeExpensePayoutMethodPrivateDetails, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin:
              ['collectiveWithSpecialPayoutPolicy', 'selfHosted', 'virtualCard'].includes(context.name) &&
              context.name !== 'manuallyCreatedVirtualCardCharge',
            collectiveAccountant: context.name === 'selfHosted',
            hostAdmin: true,
            hostAccountant: true,
            expenseOwner: true,
            limitedHostAdmin: false,
            platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
          });
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
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
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
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
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
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
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
        platformAdmin: false,
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
          platformAdmin: false,
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
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
        });
      });
    });
  });

  describe('canEditTitle', () => {
    it('only if expense is in PENDING, APPROVED, or INCOMPLETE status', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;

        // Expense owner can edit title only in specific statuses
        await expense.update({ status: 'PAID' });
        expect(await canEditTitle(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'PROCESSING' });
        expect(await canEditTitle(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'REJECTED' });
        expect(await canEditTitle(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
        expect(await canEditTitle(req.expenseOwner, expense)).to.be.false;

        // Expense owner can edit in allowed statuses
        await expense.update({ status: 'PENDING' });
        expect(await canEditTitle(req.expenseOwner, expense)).to.be.true;
        await expense.update({ status: 'INCOMPLETE' });
        expect(await canEditTitle(req.expenseOwner, expense)).to.be.true;
      });
    });

    it('only with the allowed roles in PENDING status', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'PENDING' });
        expect(await checkAllPermissions(canEditTitle, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          collectiveAccountant: false,
          hostAdmin: context.isSelfHosted,
          hostAccountant: false,
          expenseOwner: true,
          limitedHostAdmin: false,
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
        });
      });
    });

    it('only with the allowed roles in APPROVED status', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'APPROVED' });
        expect(await checkAllPermissions(canEditTitle, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          collectiveAccountant: false,
          hostAdmin: true,
          hostAccountant: false,
          expenseOwner: true,
          limitedHostAdmin: false,
          platformAdmin: ['SETTLEMENT', 'PLATFORM_BILLING'].includes(context.expense.type),
        });
      });
    });

    it('only with the allowed roles in INCOMPLETE status', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'INCOMPLETE' });
        expect(await checkAllPermissions(canEditTitle, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          collectiveAccountant: false,
          hostAdmin: true,
          hostAccountant: false,
          expenseOwner: true,
          limitedHostAdmin: false,
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
        });
      });
    });
  });

  describe('canEditType', () => {
    it('only with the allowed roles in PENDING status and of type INVOICE or RECEIPT', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        const isVirtualCard = expense.type === 'CHARGE';

        if (isVirtualCard) {
          await expense.update({ status: 'PENDING' });
          expect(await checkAllPermissions(canEditType, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: false,
            collectiveAccountant: false,
            hostAdmin: false,
            hostAccountant: false,
            expenseOwner: false,
            limitedHostAdmin: false,
            platformAdmin: false,
          });
        } else {
          await expense.update({ status: 'PENDING', type: 'RECEIPT' });
          expect(await checkAllPermissions(canEditType, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: true,
            collectiveAccountant: false,
            hostAdmin: context.isSelfHosted,
            hostAccountant: false,
            expenseOwner: true,
            limitedHostAdmin: false,
            platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
          });

          await expense.update({ status: 'PENDING', type: 'INVOICE' });
          expect(await checkAllPermissions(canEditType, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: true,
            collectiveAccountant: false,
            hostAdmin: context.isSelfHosted,
            hostAccountant: false,
            expenseOwner: true,
            limitedHostAdmin: false,
            platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
          });

          await expense.update({ status: 'PENDING', type: 'UNCLASSIFIED' });
          expect(await checkAllPermissions(canEditType, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: false,
            collectiveAccountant: false,
            hostAdmin: false,
            hostAccountant: false,
            expenseOwner: false,
            limitedHostAdmin: false,
            platformAdmin: false,
          });
        }
      });
    });

    it('only with the allowed roles in APPROVED status and of type INVOICE or RECEIPT', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;

        if (['CHARGE', 'PLATFORM_BILLING', 'SETTLEMENT'].includes(expense.type)) {
          // A virtual card is never supposed to be in an APPROVED state...
          await expense.update({ status: 'APPROVED' });
          expect(await checkAllPermissions(canEditType, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: false,
            collectiveAccountant: false,
            hostAdmin: false,
            hostAccountant: false,
            expenseOwner: false,
            limitedHostAdmin: false,
            platformAdmin: false,
          });
        } else {
          await expense.update({ status: 'APPROVED', type: 'RECEIPT' });
          expect(await checkAllPermissions(canEditType, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: context.isSelfHosted,
            collectiveAccountant: false,
            hostAdmin: true,
            hostAccountant: false,
            expenseOwner: true,
            limitedHostAdmin: false,
            platformAdmin: false,
          });

          await expense.update({ status: 'APPROVED', type: 'INVOICE' });
          expect(await checkAllPermissions(canEditType, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: context.isSelfHosted,
            collectiveAccountant: false,
            hostAdmin: true,
            hostAccountant: false,
            expenseOwner: true,
            limitedHostAdmin: false,
            platformAdmin: false,
          });

          await expense.update({ status: 'APPROVED', type: 'UNCLASSIFIED' });
          expect(await checkAllPermissions(canEditType, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: false,
            collectiveAccountant: false,
            hostAdmin: false,
            hostAccountant: false,
            expenseOwner: false,
            limitedHostAdmin: false,
            platformAdmin: false,
          });
        }
      });
    });

    it('only with the allowed roles in INCOMPLETE status and of type INVOICE or RECEIPT', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;

        const isVirtualCard = expense.type === 'CHARGE';

        if (isVirtualCard) {
          await expense.update({ status: 'INCOMPLETE' });
          expect(await checkAllPermissions(canEditType, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: false,
            collectiveAccountant: false,
            hostAdmin: false,
            hostAccountant: false,
            expenseOwner: false,
            limitedHostAdmin: false,
            platformAdmin: false,
          });
        } else {
          await expense.update({ status: 'INCOMPLETE', type: 'RECEIPT' });
          expect(await checkAllPermissions(canEditType, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: context.isSelfHosted,
            collectiveAccountant: false,
            hostAdmin: true,
            hostAccountant: false,
            expenseOwner: true,
            limitedHostAdmin: false,
            platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
          });

          await expense.update({ status: 'INCOMPLETE', type: 'INVOICE' });
          expect(await checkAllPermissions(canEditType, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: context.isSelfHosted,
            collectiveAccountant: false,
            hostAdmin: true,
            hostAccountant: false,
            expenseOwner: true,
            limitedHostAdmin: false,
            platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
          });

          await expense.update({ status: 'INCOMPLETE', type: 'UNCLASSIFIED' });
          expect(await checkAllPermissions(canEditType, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: false,
            collectiveAccountant: false,
            hostAdmin: false,
            hostAccountant: false,
            expenseOwner: false,
            limitedHostAdmin: false,
            platformAdmin: false,
          });
        }
      });
    });
  });

  describe('canEditPaidBy', () => {
    it('only if expense is in PENDING, APPROVED, or INCOMPLETE status', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;

        // Cannot edit paidBy in disallowed statuses
        await expense.update({ status: 'PAID' });
        expect(await canEditPaidBy(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'PROCESSING' });
        expect(await canEditPaidBy(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'REJECTED' });
        expect(await canEditPaidBy(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
        expect(await canEditPaidBy(req.expenseOwner, expense)).to.be.false;

        // Can edit paidBy in allowed statuses
        if (!['CHARGE', 'PLATFORM_BILLING', 'SETTLEMENT'].includes(expense.type)) {
          await expense.update({ status: 'PENDING' });
          expect(await canEditPaidBy(req.expenseOwner, expense)).to.be.true;
          await expense.update({ status: 'INCOMPLETE' });
          expect(await canEditPaidBy(req.expenseOwner, expense)).to.be.true;
        } else {
          await expense.update({ status: 'PENDING' });
          expect(await canEditPaidBy(req.expenseOwner, expense)).to.be.false;
          await expense.update({ status: 'INCOMPLETE' });
          expect(await canEditPaidBy(req.expenseOwner, expense)).to.be.false;
        }
      });
    });

    it('only with the allowed roles in PENDING status', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'PENDING' });

        expect(await checkAllPermissions(canEditPaidBy, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: !['CHARGE', 'PLATFORM_BILLING', 'SETTLEMENT'].includes(expense.type),
          collectiveAccountant: false,
          hostAdmin: context.isSelfHosted,
          hostAccountant: false,
          expenseOwner: !['CHARGE', 'PLATFORM_BILLING', 'SETTLEMENT'].includes(expense.type),
          limitedHostAdmin: false,
          platformAdmin: false,
        });
      });
    });

    it('only with the allowed roles in APPROVED status', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'APPROVED' });

        expect(await checkAllPermissions(canEditPaidBy, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: context.isSelfHosted,
          collectiveAccountant: false,
          hostAdmin: !['CHARGE', 'PLATFORM_BILLING', 'SETTLEMENT'].includes(expense.type),
          hostAccountant: false,
          expenseOwner: false,
          limitedHostAdmin: false,
          platformAdmin: false,
        });
      });
    });

    it('only with the allowed roles in INCOMPLETE status', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'INCOMPLETE' });

        expect(await checkAllPermissions(canEditPaidBy, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: context.isSelfHosted,
          collectiveAccountant: false,
          hostAdmin: !['CHARGE', 'PLATFORM_BILLING', 'SETTLEMENT'].includes(expense.type),
          hostAccountant: false,
          expenseOwner: !['CHARGE', 'PLATFORM_BILLING', 'SETTLEMENT'].includes(expense.type),
          limitedHostAdmin: false,
          platformAdmin: false,
        });
      });
    });
  });

  describe('canEditPayee', () => {
    it('only if expense is in one of the allowed status', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;

        // Cannot edit payee in disallowed statuses
        await expense.update({ status: 'PAID' });
        expect(await canEditPayee(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'PROCESSING' });
        expect(await canEditPayee(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'REJECTED' });
        expect(await canEditPayee(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
        expect(await canEditPayee(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'INCOMPLETE' });
        expect(await canEditPayee(req.expenseOwner, expense)).to.be.false;

        // Can edit payee only in PENDING status
        await expense.update({ status: 'APPROVED' });
        expect(await canEditPayee(req.expenseOwner, expense)).to.be.true;
        await expense.update({ status: 'PENDING' });
        expect(await canEditPayee(req.expenseOwner, expense)).to.be.true;
      });
    });

    it('only the expense owner can edit the payee', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'PENDING' });

        expect(await checkAllPermissions(canEditPayee, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: false,
          collectiveAccountant: false,
          hostAdmin: false,
          hostAccountant: false,
          expenseOwner: true,
          limitedHostAdmin: false,
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
        });
      });
    });
  });

  describe('canEditPayoutMethod', () => {
    it('only if expense is in PENDING or INCOMPLETE status', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;

        // Cannot edit payout method in disallowed statuses
        await expense.update({ status: 'PAID' });
        expect(await canEditPayoutMethod(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'PROCESSING' });
        expect(await canEditPayoutMethod(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'REJECTED' });
        expect(await canEditPayoutMethod(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
        expect(await canEditPayoutMethod(req.expenseOwner, expense)).to.be.false;

        // Can edit payout method in allowed statuses
        await expense.update({ status: 'APPROVED' });
        expect(await canEditPayoutMethod(req.expenseOwner, expense)).to.be.true;
        await expense.update({ status: 'PENDING' });
        expect(await canEditPayoutMethod(req.expenseOwner, expense)).to.be.true;
        await expense.update({ status: 'INCOMPLETE' });
        expect(await canEditPayoutMethod(req.expenseOwner, expense)).to.be.true;
      });
    });

    it('only the expense owner can edit the payout method', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'PENDING' });

        expect(await checkAllPermissions(canEditPayoutMethod, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: false,
          collectiveAccountant: false,
          hostAdmin: false,
          hostAccountant: false,
          expenseOwner: true,
          limitedHostAdmin: false,
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
        });
      });
    });
  });

  describe('canEditItems', () => {
    it('only if expense is in PENDING, APPROVED, or INCOMPLETE status', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;

        // Cannot edit items in disallowed statuses
        await expense.update({ status: 'PAID' });
        expect(await canEditItems(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'PROCESSING' });
        expect(await canEditItems(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'REJECTED' });
        expect(await canEditItems(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
        expect(await canEditItems(req.expenseOwner, expense)).to.be.false;

        // Owner can edit items in PENDING, APPROVED or INCOMPLETE statuses
        await expense.update({ status: 'PENDING' });
        expect(await canEditItems(req.expenseOwner, expense)).to.be.true;
        await expense.update({ status: 'INCOMPLETE' });
        expect(await canEditItems(req.expenseOwner, expense)).to.be.true;
        await expense.update({ status: 'APPROVED' });
        expect(await canEditItems(req.expenseOwner, expense)).to.be.true;

        // But host admin can
        expect(await canEditItems(req.hostAdmin, expense)).to.be.true;
      });
    });

    it('only with the allowed roles in PENDING status', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'PENDING' });

        expect(await checkAllPermissions(canEditItems, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: false,
          collectiveAccountant: false,
          hostAdmin: false,
          hostAccountant: false,
          expenseOwner: true,
          limitedHostAdmin: false,
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
        });
      });
    });

    it('only with the allowed roles in APPROVED status', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'APPROVED' });
        expect(await checkAllPermissions(canEditItems, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: context.isSelfHosted,
          collectiveAccountant: false,
          hostAdmin: true,
          hostAccountant: false,
          expenseOwner: true,
          limitedHostAdmin: false,
          platformAdmin: ['SETTLEMENT', 'PLATFORM_BILLING'].includes(expense.type),
        });
      });
    });

    it('only with the allowed roles in INCOMPLETE status', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'INCOMPLETE' });

        expect(await checkAllPermissions(canEditItems, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: context.isSelfHosted,
          collectiveAccountant: false,
          hostAdmin: true,
          hostAccountant: false,
          expenseOwner: true,
          limitedHostAdmin: false,
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
        });
      });
    });
  });

  describe('canAttachReceipts', () => {
    it('only if expense is of type CHARGE and in PAID or PROCESSING status', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;

        // Cannot attach receipts in disallowed statuses
        await expense.update({ status: 'PENDING' });
        expect(await canAttachReceipts(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'APPROVED' });
        expect(await canAttachReceipts(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'REJECTED' });
        expect(await canAttachReceipts(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
        expect(await canAttachReceipts(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'INCOMPLETE' });
        expect(await canAttachReceipts(req.expenseOwner, expense)).to.be.false;

        const isVirtualCard = expense.type === 'CHARGE';
        if (isVirtualCard) {
          // Can attach receipts in allowed statuses if it is a virtual card
          await expense.update({ status: 'PAID' });
          expect(await canAttachReceipts(req.expenseOwner, expense)).to.be.true;
          await expense.update({ status: 'PROCESSING' });
          expect(await canAttachReceipts(req.expenseOwner, expense)).to.be.true;
        } else {
          // But not if it is not a virtual card
          await expense.update({ status: 'PAID' });
          expect(await canAttachReceipts(req.expenseOwner, expense)).to.be.false;
          await expense.update({ status: 'PROCESSING' });
          expect(await canAttachReceipts(req.expenseOwner, expense)).to.be.false;
        }
      });
    });

    it('only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'PAID' });

        const isVirtualCard = expense.type === 'CHARGE';

        expect(await checkAllPermissions(canAttachReceipts, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: isVirtualCard,
          collectiveAccountant: false,
          hostAdmin: isVirtualCard,
          hostAccountant: false,
          expenseOwner: isVirtualCard,
          limitedHostAdmin: false,
          platformAdmin: false,
        });
      });
    });
  });

  describe('canEditItemDescription', () => {
    it('only if expense is of type CHARGE and in PAID or PROCESSING status', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;

        // Cannot edit item description in disallowed statuses
        await expense.update({ status: 'PENDING' });
        expect(await canEditItemDescription(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'APPROVED' });
        expect(await canEditItemDescription(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'REJECTED' });
        expect(await canEditItemDescription(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'SCHEDULED_FOR_PAYMENT' });
        expect(await canEditItemDescription(req.expenseOwner, expense)).to.be.false;
        await expense.update({ status: 'INCOMPLETE' });
        expect(await canEditItemDescription(req.expenseOwner, expense)).to.be.false;

        const isVirtualCard = expense.type === 'CHARGE';

        if (isVirtualCard) {
          // Can edit item description in allowed statuses
          await expense.update({ status: 'PAID' });
          expect(await canEditItemDescription(req.expenseOwner, expense)).to.be.true;
          await expense.update({ status: 'PROCESSING' });
          expect(await canEditItemDescription(req.expenseOwner, expense)).to.be.true;
        } else {
          // But not if it is not a CHARGE
          await expense.update({ status: 'PAID' });
          expect(await canEditItemDescription(req.expenseOwner, expense)).to.be.false;
          await expense.update({ status: 'PROCESSING' });
          expect(await canEditItemDescription(req.expenseOwner, expense)).to.be.false;
        }
      });
    });

    it('only with the allowed roles', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'PAID' });
        const isVirtualCard = expense.type === 'CHARGE';

        expect(await checkAllPermissions(canEditItemDescription, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: isVirtualCard,
          collectiveAccountant: false,
          hostAdmin: isVirtualCard,
          hostAccountant: false,
          expenseOwner: isVirtualCard,
          limitedHostAdmin: false,
          platformAdmin: false,
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
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
        });
      });
    });

    it('can delete PENDING and DRAFT expenses if the user is the owner', async () => {
      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'PENDING' });
        expect(await checkAllPermissions(canDeleteExpense, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: false,
          collectiveAccountant: false,
          hostAdmin: false,
          hostAccountant: false,
          expenseOwner: true,
          limitedHostAdmin: false,
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
        });
      });

      await runForAllContexts(async context => {
        const { expense } = context;
        await expense.update({ status: 'DRAFT' });
        expect(await checkAllPermissions(canDeleteExpense, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: true,
          collectiveAccountant: false,
          hostAdmin: true,
          hostAccountant: false,
          expenseOwner: true,
          limitedHostAdmin: false,
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
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
        expect(await canPayExpense(req.hostAdmin, expense)).to.eq(context.expense.type !== 'CHARGE');
        await expense.update({ status: 'PROCESSING' });
        expect(await canPayExpense(req.hostAdmin, expense)).to.be.false;
        await expense.update({ status: 'ERROR' });
        expect(await canPayExpense(req.hostAdmin, expense)).to.eq(context.expense.type !== 'CHARGE');
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
          hostAdmin: expense.type !== 'CHARGE',
          expenseOwner: false,
          limitedHostAdmin: false,
          collectiveAccountant: false,
          hostAccountant: false,
          platformAdmin: false,
        });
      });
    });
  });

  describe('canMarkAsPaid', () => {
    it('only if approved or error', async () => {
      await runForAllContexts(async context => {
        const { expense, req } = context;
        await expense.update({ status: 'PENDING' });
        expect(await canPayExpense(req.hostAdmin, expense)).to.be.false;
        await expense.update({ status: 'APPROVED' });
        expect(await canPayExpense(req.hostAdmin, expense)).to.eq(context.expense.type !== 'CHARGE');
        await expense.update({ status: 'PROCESSING' });
        expect(await canPayExpense(req.hostAdmin, expense)).to.be.false;
        await expense.update({ status: 'ERROR' });
        expect(await canPayExpense(req.hostAdmin, expense)).to.eq(context.expense.type !== 'CHARGE');
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
        await expense.reload();
        expect(await checkAllPermissions(canMarkAsPaid, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: context.isSelfHosted ? true : false,
          hostAdmin: expense.type !== 'CHARGE' || !!expense.data?.isManualVirtualCardCharge,
          expenseOwner: false,
          limitedHostAdmin: false,
          collectiveAccountant: false,
          hostAccountant: false,
          platformAdmin: false,
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
          collectiveAdmin: context.expense.type !== 'CHARGE',
          hostAdmin: context.expense.type !== 'CHARGE' || Boolean(context.expense.data?.isManualVirtualCardCharge),
          expenseOwner: false,
          limitedHostAdmin: false,
          collectiveAccountant: false,
          hostAccountant: false,
          platformAdmin: false,
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

    describe('manually created virtual card charges', () => {
      it('allows host admins to approve', async () => {
        await contexts.manuallyCreatedVirtualCardCharge.expense.update({ status: 'PENDING' });
        await contexts.manuallyCreatedVirtualCardCharge.expense.reload();
        expect(
          await canApprove(
            contexts.manuallyCreatedVirtualCardCharge.req.hostAdmin,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.true;
      });

      it('does not allow other roles to approve', async () => {
        await contexts.manuallyCreatedVirtualCardCharge.expense.update({ status: 'PENDING' });
        await contexts.manuallyCreatedVirtualCardCharge.expense.reload();
        expect(
          await canApprove(
            contexts.manuallyCreatedVirtualCardCharge.req.collectiveAdmin,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.false;
        expect(
          await canApprove(
            contexts.manuallyCreatedVirtualCardCharge.req.expenseOwner,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.false;
        expect(
          await canApprove(
            contexts.manuallyCreatedVirtualCardCharge.req.randomUser,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.false;
        expect(
          await canApprove(
            contexts.manuallyCreatedVirtualCardCharge.req.public,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.false;
      });

      it('only allows approval when status is PENDING, REJECTED, or INCOMPLETE', async () => {
        await contexts.manuallyCreatedVirtualCardCharge.expense.update({ status: 'PENDING' });
        await contexts.manuallyCreatedVirtualCardCharge.expense.reload();
        expect(
          await canApprove(
            contexts.manuallyCreatedVirtualCardCharge.req.hostAdmin,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.true;
        await contexts.manuallyCreatedVirtualCardCharge.expense.update({ status: 'REJECTED' });
        await contexts.manuallyCreatedVirtualCardCharge.expense.reload();
        expect(
          await canApprove(
            contexts.manuallyCreatedVirtualCardCharge.req.hostAdmin,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.true;
        await contexts.manuallyCreatedVirtualCardCharge.expense.update({ status: 'INCOMPLETE' });
        await contexts.manuallyCreatedVirtualCardCharge.expense.reload();
        expect(
          await canApprove(
            contexts.manuallyCreatedVirtualCardCharge.req.hostAdmin,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.true;
        await contexts.manuallyCreatedVirtualCardCharge.expense.update({ status: 'APPROVED' });
        await contexts.manuallyCreatedVirtualCardCharge.expense.reload();
        expect(
          await canApprove(
            contexts.manuallyCreatedVirtualCardCharge.req.hostAdmin,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.false;
        await contexts.manuallyCreatedVirtualCardCharge.expense.update({ status: 'PAID' });
        await contexts.manuallyCreatedVirtualCardCharge.expense.reload();
        expect(
          await canApprove(
            contexts.manuallyCreatedVirtualCardCharge.req.hostAdmin,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.false;
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
          collectiveAdmin: !['CHARGE', 'PLATFORM_BILLING', 'SETTLEMENT'].includes(expense.type),
          hostAdmin: !['CHARGE', 'PLATFORM_BILLING', 'SETTLEMENT'].includes(expense.type),
          expenseOwner: false,
          limitedHostAdmin: false,
          collectiveAccountant: false,
          hostAccountant: false,
          platformAdmin: ['SETTLEMENT', 'PLATFORM_BILLING'].includes(expense.type),
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
          collectiveAdmin: !['CHARGE', 'PLATFORM_BILLING', 'SETTLEMENT'].includes(expense.type),
          hostAdmin: !['CHARGE', 'PLATFORM_BILLING', 'SETTLEMENT'].includes(expense.type),
          expenseOwner: false,
          limitedHostAdmin: false,
          collectiveAccountant: false,
          hostAccountant: false,
          platformAdmin: false,
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

    describe('only with the allowed roles', () => {
      runEachForAllContexts(key => {
        it(key, async () => {
          const context = contexts[key];
          const { expense } = context;
          await expense.update({ status: 'PAID' });
          const isVirtualCard = expense.type === 'CHARGE';
          expect(await checkAllPermissions(canMarkAsUnpaid, context)).to.deep.equal({
            public: false,
            randomUser: false,
            collectiveAdmin: isVirtualCard ? false : context.isSelfHosted,
            hostAdmin: !isVirtualCard
              ? !['SETTLEMENT', 'PLATFORM_BILLING'].includes(expense.type)
              : Boolean(expense.data?.isManualVirtualCardCharge),
            expenseOwner: false,
            limitedHostAdmin: false,
            collectiveAccountant: false,
            hostAccountant: false,
            platformAdmin: ['SETTLEMENT', 'PLATFORM_BILLING'].includes(expense.type),
          });
        });
      });
    });

    describe('not if the expense is a virtual card', () => {
      let expense;
      before(async () => {
        expense = contexts.virtualCard.expense;
        await expense.update({ status: 'PAID', type: 'CHARGE' });
      });
      for (const [c] of Object.entries(contexts.virtualCard.req)) {
        it(c, async () => {
          const userReq = contexts.virtualCard.req[c];
          expect(await canMarkAsUnpaid(userReq, expense)).to.be.false;
        });
      }
    });

    describe('manually created virtual card charges', () => {
      it('allows host admins to mark as unpaid', async () => {
        await contexts.manuallyCreatedVirtualCardCharge.expense.update({ status: 'PAID' });
        await contexts.manuallyCreatedVirtualCardCharge.expense.reload();
        expect(
          await canMarkAsUnpaid(
            contexts.manuallyCreatedVirtualCardCharge.req.hostAdmin,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.true;
      });

      it('does not allow other roles to mark as unpaid', async () => {
        await contexts.manuallyCreatedVirtualCardCharge.expense.update({ status: 'PAID' });
        await contexts.manuallyCreatedVirtualCardCharge.expense.reload();
        expect(
          await canMarkAsUnpaid(
            contexts.manuallyCreatedVirtualCardCharge.req.collectiveAdmin,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.false;
        expect(
          await canMarkAsUnpaid(
            contexts.manuallyCreatedVirtualCardCharge.req.expenseOwner,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.false;
        expect(
          await canMarkAsUnpaid(
            contexts.manuallyCreatedVirtualCardCharge.req.randomUser,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.false;
        expect(
          await canMarkAsUnpaid(
            contexts.manuallyCreatedVirtualCardCharge.req.public,
            contexts.manuallyCreatedVirtualCardCharge.expense,
          ),
        ).to.be.false;
      });
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
          platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
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
          platformAdmin: false,
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
            platformAdmin: ['settlement', 'platformBilling'].includes(context.name),
          });
        },
        {
          except: contexts.virtualCard,
        },
      );
    });
  });

  describe('canSeeDraftKey', () => {
    it('can not be seen if the expense is not a DRAFT', async () => {
      await runForAllContexts(async context => {
        await context.expense.update({ status: 'PENDING' });
        expect(await checkAllPermissions(canSeeDraftKey, context)).to.deep.equal({
          public: false,
          randomUser: false,
          collectiveAdmin: false,
          collectiveAccountant: false,
          hostAdmin: false,
          hostAccountant: false,
          expenseOwner: false,
          limitedHostAdmin: false,
          platformAdmin: false,
        });
      });
    });

    it('can only be seen by host admin', async () => {
      let context = contexts.normal;
      await context.expense.update({ status: 'DRAFT' });
      expect(await checkAllPermissions(canSeeDraftKey, context)).to.deep.equal({
        public: false,
        randomUser: false,
        collectiveAdmin: false,
        collectiveAccountant: false,
        hostAdmin: true,
        hostAccountant: false,
        expenseOwner: false,
        limitedHostAdmin: false,
        platformAdmin: false,
      });

      context = contexts.selfHosted;
      await context.expense.update({ status: 'DRAFT' });
      expect(await checkAllPermissions(canSeeDraftKey, context)).to.deep.equal({
        public: false,
        randomUser: false,
        collectiveAdmin: true,
        collectiveAccountant: false,
        hostAdmin: true,
        hostAccountant: false,
        expenseOwner: false,
        limitedHostAdmin: false,
        platformAdmin: false,
      });
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

        it("when it's paid and the expense currency matches the host currency", async () => {
          await createTransactionsFromPaidExpense(expense.collective.host, expense, undefined, 1.6);
          await expense.update({ status: 'PAID' });

          const amount = await getExpenseAmountInDifferentCurrency(expense, 'USD', contexts.normal.req.public);
          expect(amount).to.deep.eq({
            value: 1600,
            currency: 'USD',
            exchangeRate: null,
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

    it('resolves if the collective has not enough balance to cover for the expense - but its a settlement', async () => {
      const expense = await fakeExpense({
        currency: 'USD',
        type: 'SETTLEMENT',
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        PayoutMethodId: payoutMethod.id,
        FromCollectiveId: payoutMethod.CollectiveId,
        amount: 100001,
      });

      await expect(checkHasBalanceToPayExpense(host, expense, payoutMethod)).to.be.fulfilled;
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

    it('resolves if the collective has not enough balance to cover for the exchange rate variance - but its a settlement', async () => {
      let expense = await fakeExpense({
        currency: 'BRL',
        type: 'SETTLEMENT',
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        PayoutMethodId: payoutMethod.id,
        FromCollectiveId: payoutMethod.CollectiveId,
        amount: 500000,
      });

      await expect(checkHasBalanceToPayExpense(host, expense, payoutMethod)).to.be.fulfilled;

      expense = await fakeExpense({
        currency: 'EUR',
        type: 'SETTLEMENT',
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        PayoutMethodId: payoutMethod.id,
        FromCollectiveId: payoutMethod.CollectiveId,
        amount: 500000,
      });

      await expect(checkHasBalanceToPayExpense(host, expense, payoutMethod)).to.be.fulfilled;
    });
  });
});

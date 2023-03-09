import assert from 'assert';

import * as LibTaxes from '@opencollective/taxes';
import debugLib from 'debug';
import express from 'express';
import {
  cloneDeep,
  find,
  flatten,
  get,
  isBoolean,
  isEqual,
  isNil,
  isNumber,
  keyBy,
  mapValues,
  omit,
  omitBy,
  pick,
  set,
  size,
  sumBy,
  uniq,
} from 'lodash';

import { activities, roles } from '../../constants';
import ActivityTypes from '../../constants/activities';
import { types as collectiveTypes } from '../../constants/collectives';
import statuses from '../../constants/expense_status';
import EXPENSE_TYPE from '../../constants/expense_type';
import { ExpenseFeesPayer } from '../../constants/expense-fees-payer';
import FEATURE from '../../constants/feature';
import { EXPENSE_PERMISSION_ERROR_CODES } from '../../constants/permissions';
import POLICIES from '../../constants/policies';
import { TransactionKind } from '../../constants/transaction-kind';
import cache from '../../lib/cache';
import { getFxRate } from '../../lib/currency';
import { simulateDBEntriesDiff } from '../../lib/data';
import errors from '../../lib/errors';
import { formatAddress } from '../../lib/format-address';
import logger from '../../lib/logger';
import { floatAmountToCents } from '../../lib/math';
import * as libPayments from '../../lib/payments';
import { getPolicy } from '../../lib/policies';
import { reportErrorToSentry, reportMessageToSentry } from '../../lib/sentry';
import { notifyTeamAboutSpamExpense } from '../../lib/spam';
import { createTransactionsForManuallyPaidExpense, createTransactionsFromPaidExpense } from '../../lib/transactions';
import twoFactorAuthLib from '../../lib/two-factor-authentication';
import { canUseFeature } from '../../lib/user-permissions';
import { formatCurrency, parseToBoolean } from '../../lib/utils';
import models, { Collective, sequelize } from '../../models';
import Expense from '../../models/Expense';
import { ExpenseAttachedFile } from '../../models/ExpenseAttachedFile';
import { ExpenseItem } from '../../models/ExpenseItem';
import { MigrationLogType } from '../../models/MigrationLog';
import { PayoutMethodTypes } from '../../models/PayoutMethod';
import User from '../../models/User';
import paymentProviders from '../../paymentProviders';
import { Location } from '../../types/Location';
import {
  Quote as WiseQuote,
  QuoteV2 as WiseQuoteV2,
  RecipientAccount as BankAccountPayoutMethodData,
  Transfer as WiseTransfer,
} from '../../types/transferwise';
import {
  BadRequest,
  FeatureNotAllowedForUser,
  FeatureNotSupportedForCollective,
  Forbidden,
  NotFound,
  Unauthorized,
  ValidationFailed,
} from '../errors';
import { CurrencyExchangeRateSourceTypeEnum } from '../v2/enum/CurrencyExchangeRateSourceType';

import { checkRemoteUserCanRoot } from './scope-check';

const debug = debugLib('expenses');

const isOwner = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  } else if (req.remoteUser.id === expense.UserId) {
    return true;
  } else if (!expense.fromCollective) {
    expense.fromCollective = await req.loaders.Collective.byId.load(expense.FromCollectiveId);
    if (!expense.fromCollective) {
      return false;
    }
  }

  return req.remoteUser.isAdminOfCollective(expense.fromCollective);
};

const isDraftPayee = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  } else if (expense.data?.payee?.['id']) {
    return req.remoteUser.isAdmin(expense.data.payee['id']);
  } else {
    return false;
  }
};

const isCollectiveAccountant = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  } else if (req.remoteUser.hasRole(roles.ACCOUNTANT, expense.CollectiveId)) {
    return true;
  }

  const collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
  if (!collective) {
    return false;
  } else if (req.remoteUser.hasRole(roles.ACCOUNTANT, collective.HostCollectiveId)) {
    return true;
  } else if (collective.ParentCollectiveId) {
    return req.remoteUser.hasRole(roles.ACCOUNTANT, collective.ParentCollectiveId);
  } else {
    return false;
  }
};

const isCollectiveAdmin = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  if (!expense.collective) {
    expense.collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
  }

  return req.remoteUser.isAdminOfCollective(expense.collective);
};

const isHostAdmin = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  if (!expense.collective) {
    expense.collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
  }

  if (!expense.collective) {
    return false;
  }

  return req.remoteUser.isAdmin(expense.collective.HostCollectiveId) && expense.collective.isActive;
};

const isAdminOfHostWhoPaidExpense = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }
  return expense.HostCollectiveId && req.remoteUser.isAdmin(expense.HostCollectiveId);
};

export type ExpensePermissionEvaluator = (
  req: express.Request,
  expense: Expense,
  options?: { throw?: boolean },
) => Promise<boolean>;

/**
 * Returns true if the expense meets at least one condition.
 * Always returns false for unauthenticated requests.
 */
const remoteUserMeetsOneCondition = async (
  req: express.Request,
  expense: Expense,
  conditions: ExpensePermissionEvaluator[],
  options: { throw?: boolean } = { throw: false },
): Promise<boolean> => {
  if (!req.remoteUser) {
    if (options?.throw) {
      throw new Unauthorized('User is required', EXPENSE_PERMISSION_ERROR_CODES.MINIMAL_CONDITION_NOT_MET);
    }
    return false;
  }

  for (const condition of conditions) {
    if (await condition(req, expense)) {
      return true;
    }
  }

  if (options?.throw) {
    throw new Unauthorized(
      'User does not meet minimal condition',
      EXPENSE_PERMISSION_ERROR_CODES.MINIMAL_CONDITION_NOT_MET,
    );
  }
  return false;
};

/** Checks if the user can see expense's attachments (items URLs, attached files) */
export const canSeeExpenseAttachments: ExpensePermissionEvaluator = async (req, expense) => {
  return remoteUserMeetsOneCondition(req, expense, [
    isOwner,
    isCollectiveAdmin,
    isCollectiveAccountant,
    isHostAdmin,
    isAdminOfHostWhoPaidExpense,
  ]);
};

/** Checks if the user can see expense's payout method */
export const canSeeExpensePayoutMethod: ExpensePermissionEvaluator = async (req, expense) => {
  return remoteUserMeetsOneCondition(req, expense, [
    isOwner,
    isCollectiveAdmin,
    isCollectiveAccountant,
    isHostAdmin,
    isAdminOfHostWhoPaidExpense,
  ]);
};

/** Checks if the user can see expense's payout method */
export const canSeeExpenseInvoiceInfo: ExpensePermissionEvaluator = async (
  req,
  expense,
  options = { throw: false },
) => {
  return remoteUserMeetsOneCondition(
    req,
    expense,
    [isOwner, isCollectiveAdmin, isCollectiveAccountant, isHostAdmin, isAdminOfHostWhoPaidExpense],
    options,
  );
};

/** Checks if the user can see expense's payout method */
export const canSeeExpensePayeeLocation: ExpensePermissionEvaluator = async (req, expense) => {
  return remoteUserMeetsOneCondition(req, expense, [
    isOwner,
    isCollectiveAdmin,
    isCollectiveAccountant,
    isHostAdmin,
    isAdminOfHostWhoPaidExpense,
  ]);
};

export const canSeeExpenseSecurityChecks: ExpensePermissionEvaluator = async (req, expense) => {
  return remoteUserMeetsOneCondition(req, expense, [isHostAdmin]);
};

/** Checks if the user can verify or resend a draft */
export const canVerifyDraftExpense: ExpensePermissionEvaluator = async (req, expense) => {
  return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isHostAdmin]);
};

/**
 * Returns the list of items for this expense.
 */
export const getExpenseItems = async (expenseId: number, req: express.Request): Promise<ExpenseItem[]> => {
  return req.loaders.Expense.items.load(expenseId);
};

/**
 * Only admin of expense.collective or of expense.collective.host can approve/reject expenses
 * @deprecated: Please use more specific helpers like `canEdit`, `canDelete`, etc.
 */
export const canUpdateExpenseStatus: ExpensePermissionEvaluator = async (req, expense) => {
  const { remoteUser } = req;
  if (!remoteUser) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    return false;
  } else if (remoteUser.hasRole([roles.ADMIN], expense.CollectiveId)) {
    return true;
  } else {
    if (!expense.collective) {
      expense.collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
    }

    return remoteUser.isAdmin(expense.collective.HostCollectiveId);
  }
};

/**
 * Only the author or an admin of the collective or collective.host can edit an expense when it hasn't been paid yet
 */
export const canEditExpense: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  const nonEditableStatuses = ['PAID', 'PROCESSING', 'SCHEDULED_FOR_PAYMENT', 'CANCELED'];

  // Host and Collective Admin can attach receipts to paid charge expenses
  if (expense.type === EXPENSE_TYPE.CHARGE && ['PAID', 'PROCESSING'].includes(expense.status)) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin, isCollectiveAdmin], options);
  } else if (expense.status === 'DRAFT') {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin, isDraftPayee], options);
  } else if (nonEditableStatuses.includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden('Can not edit expense in current status', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot edit expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin, isCollectiveAdmin], options);
  }
};

export const canEditExpenseTags: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot edit expense tags', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else if (expense.status === 'PAID') {
    // Only collective/host admins can edit tags after the expense is paid
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin, isCollectiveAdmin], options);
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin, isCollectiveAdmin], options);
  }
};

/**
 * Only the author or an admin of the collective or collective.host can delete an expense,
 * and only when its status is REJECTED.
 */
export const canDeleteExpense: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!['REJECTED', 'DRAFT', 'SPAM', 'CANCELED'].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not delete expense in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot delete expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be paid by user
 */
export const canPayExpense: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!['APPROVED', 'ERROR'].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden('Can not pay expense in current status', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot pay expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be approved by user
 */
export const canApprove: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!['PENDING', 'REJECTED', 'INCOMPLETE'].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not approve expense in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot approve expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    expense.collective = expense.collective || (await req.loaders.Collective.byId.load(expense.CollectiveId));

    if (expense.collective.HostCollectiveId && expense.collective.approvedAt) {
      expense.collective.host =
        expense.collective.host || (await req.loaders.Collective.byId.load(expense.collective.HostCollectiveId));
    }

    const currency = expense.collective.host?.currency || expense.collective.currency;
    const hostPolicy = await getPolicy(expense.collective.host, POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE);
    const collectivePolicy = await getPolicy(expense.collective, POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE);

    let policy = collectivePolicy;
    if (hostPolicy.enabled && hostPolicy.appliesToHostedCollectives) {
      policy = hostPolicy;

      if (!hostPolicy.appliesToSingleAdminCollectives) {
        const collectiveAdminCount = await req.loaders.Member.countAdminMembersOfCollective.load(expense.collective.id);
        if (collectiveAdminCount === 1) {
          policy = collectivePolicy;
        }
      }
    }

    if (policy.enabled && expense.amount >= policy.amountInCents && req.remoteUser.id === expense.UserId) {
      if (options?.throw) {
        throw new Forbidden(
          'User cannot approve their own expenses',
          EXPENSE_PERMISSION_ERROR_CODES.AUTHOR_CANNOT_APPROVE,
          {
            reasonDetails: {
              amount: policy.amountInCents / 100,
              currency,
            },
          },
        );
      }
      return false;
    }
    if (expense.status === 'INCOMPLETE') {
      return isHostAdmin(req, expense);
    }
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be rejected by user
 */
export const canReject: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!['PENDING', 'UNVERIFIED', 'INCOMPLETE'].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not reject expense in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot reject expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be rejected by user
 */
export const canMarkAsSpam: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!['REJECTED'].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not mark expense as spam in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot mark expenses as spam', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be unapproved by user
 */
export const canUnapprove: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!['APPROVED', 'ERROR'].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not unapprove expense in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot unapprove expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin], options);
  }
};

export const canMarkAsIncomplete: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!['APPROVED', 'PENDING', 'ERROR'].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not mark expense as incomplete in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden(
        'User cannot mark expense as incomplete',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE,
      );
    }
    return false;
  } else {
    return isHostAdmin(req, expense);
  }
};

/**
 * Returns true if expense can be marked as unpaid by user
 */
export const canMarkAsUnpaid: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (expense.status !== 'PAID') {
    if (options?.throw) {
      throw new Forbidden(
        'Can not mark expense as unpaid in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (expense.type === EXPENSE_TYPE.CHARGE) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not mark this type of expense as unpaid',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_TYPE,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden(
        'User cannot mark expenses as unpaid',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE,
      );
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
  }
};

/**
 * Returns true if user can comment and see others comments for this expense
 */
export const canComment: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot pay expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin, isOwner], options);
  }
};

export const canViewRequiredLegalDocuments: ExpensePermissionEvaluator = async (req, expense) => {
  return remoteUserMeetsOneCondition(req, expense, [
    isHostAdmin,
    isCollectiveAdmin,
    isCollectiveAccountant,
    isOwner,
    isAdminOfHostWhoPaidExpense,
  ]);
};

export const canUnschedulePayment: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (expense.status !== 'SCHEDULED_FOR_PAYMENT') {
    if (options?.throw) {
      throw new Forbidden('Can not pay expense in current status', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
    }
    return false;
  }
  return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
};

// ---- Expense actions ----

export const approveExpense = async (req: express.Request, expense: Expense): Promise<Expense> => {
  if (expense.status === 'APPROVED') {
    return expense;
  } else if (!(await canApprove(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: 'APPROVED', lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_APPROVED, req.remoteUser);
  return updatedExpense;
};

export const unapproveExpense = async (req: express.Request, expense: Expense): Promise<Expense> => {
  if (expense.status === 'PENDING') {
    return expense;
  } else if (!(await canUnapprove(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: 'PENDING', lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_UNAPPROVED, req.remoteUser);
  return updatedExpense;
};

export const markExpenseAsIncomplete = async (
  req: express.Request,
  expense: Expense,
  message?: string,
): Promise<Expense> => {
  if (expense.status === 'INCOMPLETE') {
    return expense;
  } else if (!(await canMarkAsIncomplete(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: 'INCOMPLETE', lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE, req.remoteUser, { message });
  return updatedExpense;
};

export const rejectExpense = async (req: express.Request, expense: Expense): Promise<Expense> => {
  if (expense.status === 'REJECTED') {
    return expense;
  } else if (!(await canReject(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: 'REJECTED', lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_REJECTED, req.remoteUser);
  return updatedExpense;
};

export const markExpenseAsSpam = async (req: express.Request, expense: Expense): Promise<Expense> => {
  if (expense.status === 'SPAM') {
    return expense;
  } else if (!(await canMarkAsSpam(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: 'SPAM', lastEditedById: req.remoteUser.id });

  // Limit the user so they can't submit expenses in the future
  const submittedByUser = await updatedExpense.getSubmitterUser();
  await submittedByUser.limitFeature(FEATURE.USE_EXPENSES);

  // Cancel recurring expense
  const recurringExpense = await expense.getRecurringExpense();
  if (recurringExpense) {
    await recurringExpense.destroy();
  }

  // We create the activity as a good practice but there is no email sent right now
  const activity = await expense.createActivity(activities.COLLECTIVE_EXPENSE_MARKED_AS_SPAM, req.remoteUser);

  // For now, we send the Slack notification directly from here as there is no framework in activities/notifications
  notifyTeamAboutSpamExpense(activity);

  return updatedExpense;
};

const ROLLING_LIMIT_CACHE_VALIDITY = 3600; // 1h in secs for cache to expire

async function validateExpensePayout2FALimit(req, host, expense, expensePaidAmountKey) {
  const hostPayoutTwoFactorAuthenticationRollingLimit = get(
    host,
    'settings.payoutsTwoFactorAuth.rollingLimit',
    1000000,
  );

  const twoFactorSession =
    req.jwtPayload?.sessionId || (req.personalToken?.id && `personalToken_${req.personalToken.id}`);

  const currentPaidExpenseAmountCache = await cache.get(expensePaidAmountKey);
  const currentPaidExpenseAmount = currentPaidExpenseAmountCache || 0;

  // requires a 2FA token to be present if there is no value in the cache (first payout by user)
  // or the this payout would put the user over the rolling limit.
  const use2FAToken =
    isNil(currentPaidExpenseAmountCache) ||
    currentPaidExpenseAmount + expense.amount > hostPayoutTwoFactorAuthenticationRollingLimit;

  if (!twoFactorAuthLib.userHasTwoFactorAuthEnabled(req.remoteUser)) {
    throw new Error('Host has two-factor authentication enabled for large payouts.');
  }

  await twoFactorAuthLib.validateRequest(req, {
    requireTwoFactorAuthEnabled: true, // requires user to have 2FA configured
    alwaysAskForToken: use2FAToken,
    sessionDuration: ROLLING_LIMIT_CACHE_VALIDITY, // duration of a auth session after a token is presented
    sessionKey: `2fa_expense_payout_${twoFactorSession}`, // key of the 2fa session where the 2fa will be valid for the duration
  });

  if (use2FAToken) {
    // if a 2fa token was used, reset rolling limit
    cache.set(expensePaidAmountKey, 0, ROLLING_LIMIT_CACHE_VALIDITY);
  } else {
    cache.set(expensePaidAmountKey, currentPaidExpenseAmount + expense.amount, ROLLING_LIMIT_CACHE_VALIDITY);
  }
}

export const scheduleExpenseForPayment = async (
  req: express.Request,
  expense: Expense,
  options: { feesPayer?: 'COLLECTIVE' | 'PAYEE' } = {},
): Promise<Expense> => {
  if (expense.status === 'SCHEDULED_FOR_PAYMENT') {
    throw new BadRequest('Expense is already scheduled for payment');
  } else if (!(await canPayExpense(req, expense))) {
    throw new Forbidden("You're authenticated but you can't schedule this expense for payment");
  }

  const host = await expense.collective.getHostCollective();
  if (expense.currency !== expense.collective.currency && !hasMultiCurrency(expense.collective, host)) {
    throw new Unauthorized('Multi-currency expenses are not enabled for this collective');
  }

  const payoutMethod = await expense.getPayoutMethod();
  await checkHasBalanceToPayExpense(host, expense, payoutMethod);
  if (payoutMethod.type === PayoutMethodTypes.PAYPAL) {
    const hostHasPayoutTwoFactorAuthenticationEnabled = get(host, 'settings.payoutsTwoFactorAuth.enabled', false);

    if (hostHasPayoutTwoFactorAuthenticationEnabled) {
      const expensePaidAmountKey = `${req.remoteUser.id}_2fa_payment_limit`;
      await validateExpensePayout2FALimit(req, host, expense, expensePaidAmountKey);
    }
  }

  const { feesPayer } = options;
  if (feesPayer && feesPayer !== expense.feesPayer) {
    await expense.update({ feesPayer: feesPayer });
  }

  // If Wise, add expense to a new batch group
  if (payoutMethod.type === PayoutMethodTypes.BANK_ACCOUNT) {
    await paymentProviders.transferwise.scheduleExpenseForPayment(expense);
  }
  // If PayPal, check if host is connected to PayPal
  else if (payoutMethod.type === PayoutMethodTypes.PAYPAL) {
    await host.getAccountForPaymentProvider('paypal');
  }

  const updatedExpense = await expense.update({
    status: 'SCHEDULED_FOR_PAYMENT',
    lastEditedById: req.remoteUser.id,
  });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT, req.remoteUser);
  return updatedExpense;
};

export const unscheduleExpensePayment = async (req: express.Request, expense: Expense): Promise<Expense> => {
  if (!(await canUnschedulePayment(req, expense))) {
    throw new BadRequest("Expense is not scheduled for payment or you don't have authorization to unschedule it");
  }

  // If Wise, add expense to a new batch group
  const payoutMethod = await expense.getPayoutMethod();
  if (payoutMethod.type === PayoutMethodTypes.BANK_ACCOUNT) {
    await paymentProviders.transferwise.unscheduleExpenseForPayment(expense);
  }

  const updatedExpense = await expense.update({
    status: 'APPROVED',
    lastEditedById: req.remoteUser.id,
  });

  await expense.createActivity(activities.COLLECTIVE_EXPENSE_UNSCHEDULED_FOR_PAYMENT, req.remoteUser);

  return updatedExpense;
};

/** Compute the total amount of expense from expense items */
const computeTotalAmountForExpense = (items: (ExpenseItem | Record<string, unknown>)[], taxes: TaxDefinition[]) => {
  return Math.round(
    sumBy(items, item => {
      const totalTaxes = sumBy(taxes, tax => <number>item['amount'] * tax.rate);
      return <number>item['amount'] + totalTaxes;
    }),
  );
};

/** Check expense's items values, throw if something's wrong */
const checkExpenseItems = (expenseType, items: (ExpenseItem | Record<string, unknown>)[], taxes) => {
  // Check the number of items
  if (!items || items.length === 0) {
    throw new ValidationFailed('Your expense needs to have at least one item');
  } else if (items.length > 300) {
    throw new ValidationFailed('Expenses cannot have more than 300 items');
  }

  // Check amounts
  items.forEach((item, idx) => {
    if (isNil(item.amount)) {
      throw new ValidationFailed(
        `Amount not set for item ${item.description ? `"${item.description}"` : `number ${idx}`}`,
      );
    }
  });

  const sumItems = computeTotalAmountForExpense(items, taxes);
  if (!sumItems) {
    throw new ValidationFailed(`The sum of all items must be above 0`);
  }

  // If expense is a receipt (not an invoice) then files must be attached
  if (expenseType === EXPENSE_TYPE.RECEIPT) {
    const hasMissingFiles = items.some(a => !a.url);
    if (hasMissingFiles) {
      throw new ValidationFailed('Some items are missing a file');
    }
  }
};

const checkExpenseType = (
  type: EXPENSE_TYPE,
  account: Collective,
  parent: Collective | null,
  host: Collective | null,
): void => {
  // Check flag in settings in the priority order of collective > parent > host
  const accounts = { account, parent, host };
  for (const level of ['account', 'parent', 'host']) {
    const account = accounts[level];
    const value = account?.settings?.expenseTypes?.[type];
    if (isBoolean(value)) {
      if (value) {
        return; // Flag is explicitly set to true, we're good
      } else {
        throw new ValidationFailed(`Expenses of type ${type.toLowerCase()} are not allowed by the ${level}`);
      }
    }
  }

  // Fallback on default values
  if (type === EXPENSE_TYPE.GRANT) {
    // TODO: enforce this to resolve https://github.com/opencollective/opencollective/issues/5395
  }
};

const getPayoutMethodFromExpenseData = async (expenseData, remoteUser, fromCollective, dbTransaction) => {
  if (expenseData.payoutMethod) {
    if (expenseData.payoutMethod.id) {
      const pm = await models.PayoutMethod.findByPk(expenseData.payoutMethod.id);
      if (!pm) {
        throw new Error('This payout method does not exist.');
      }
      // Special case: Payout Method from the Host for "Expense Accross Hosts"
      // No need for extra checks
      if (
        pm.CollectiveId === fromCollective.HostCollectiveId &&
        [PayoutMethodTypes.BANK_ACCOUNT, PayoutMethodTypes.PAYPAL].includes(pm.type)
      ) {
        return pm;
      }
      if (!remoteUser.isAdmin(pm.CollectiveId)) {
        throw new Error("You don't have the permission to use this payout method.");
      }
      if (pm.CollectiveId !== fromCollective.id) {
        throw new Error('This payout method cannot be used for this collective');
      }
      return pm;
    } else {
      return models.PayoutMethod.getOrCreateFromData(
        expenseData.payoutMethod,
        remoteUser,
        fromCollective,
        dbTransaction,
      );
    }
  } else {
    return null;
  }
};

/** Creates attached files for the given expense */
const createAttachedFiles = async (expense, attachedFilesData, remoteUser, transaction) => {
  if (size(attachedFilesData) > 0) {
    return Promise.all(
      attachedFilesData.map(attachedFile => {
        return models.ExpenseAttachedFile.createFromData(attachedFile, remoteUser, expense, transaction);
      }),
    );
  } else {
    return [];
  }
};

export const hasMultiCurrency = (collective, host): boolean => {
  return collective.currency === host?.currency; // Only support multi-currency when collective/host have the same currency
};

type TaxDefinition = {
  type: string;
  rate: number;
  idNumber: string;
};

type ExpenseData = {
  id?: number;
  payoutMethod?: Record<string, unknown>;
  payeeLocation?: Location;
  items?: Record<string, unknown>[];
  attachedFiles?: Record<string, unknown>[];
  collective?: Collective;
  fromCollective?: Collective;
  tags?: string[];
  incurredAt?: Date;
  type?: EXPENSE_TYPE;
  description?: string;
  privateMessage?: string;
  invoiceInfo?: string;
  longDescription?: string;
  amount?: number;
  currency?: string;
  tax?: TaxDefinition[];
};

const EXPENSE_EDITABLE_FIELDS = [
  'amount',
  'currency',
  'description',
  'longDescription',
  'type',
  'tags',
  'privateMessage',
  'invoiceInfo',
  'payeeLocation',
] as const;

type ExpenseEditableFieldsUnion = (typeof EXPENSE_EDITABLE_FIELDS)[number];

const EXPENSE_PAID_CHARGE_EDITABLE_FIELDS = ['description', 'tags', 'privateMessage', 'invoiceInfo'];

const checkTaxes = (account, host, expenseType: string, taxes): void => {
  if (!taxes?.length) {
    return;
  } else if (taxes.length > 1) {
    throw new ValidationFailed('Only one tax is allowed per expense');
  } else if (expenseType !== EXPENSE_TYPE.INVOICE) {
    throw new ValidationFailed('Only invoices can have taxes');
  } else {
    return taxes.forEach(({ type, rate }) => {
      if (rate < 0 || rate > 1) {
        throw new ValidationFailed(`Tax rate for ${type} must be between 0% and 100%`);
      } else if (type === LibTaxes.TaxType.VAT && !LibTaxes.accountHasVAT(account, host)) {
        throw new ValidationFailed(`This account does not have VAT enabled`);
      } else if (type === LibTaxes.TaxType.GST && !LibTaxes.accountHasGST(host)) {
        throw new ValidationFailed(`This host does not have GST enabled`);
      }
    });
  }
};

export async function createExpense(remoteUser: User | null, expenseData: ExpenseData): Promise<Expense> {
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to create an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  if (!get(expenseData, 'collective.id')) {
    throw new Unauthorized('Missing expense.collective.id');
  }

  const collective = await models.Collective.findByPk(expenseData.collective.id, {
    include: [
      { association: 'host', required: false },
      { association: 'parent', required: false },
    ],
  });
  if (!collective) {
    throw new ValidationFailed('Collective not found');
  }

  const isMember = Boolean(remoteUser.rolesByCollectiveId[String(collective.id)]);
  if (
    expenseData.collective.settings?.['disablePublicExpenseSubmission'] &&
    !isMember &&
    !remoteUser.isAdminOfCollectiveOrHost(collective) &&
    !remoteUser.isRoot()
  ) {
    throw new Error('You must be a member of the collective to create new expense');
  }

  const itemsData = expenseData.items;
  const taxes = expenseData.tax || [];

  checkTaxes(collective, collective.host, expenseData.type, taxes);
  checkExpenseItems(expenseData.type, itemsData, taxes);
  checkExpenseType(expenseData.type, collective, collective.parent, collective.host);

  if (size(expenseData.attachedFiles) > 15) {
    throw new ValidationFailed('The number of files that you can attach to an expense is limited to 15');
  }

  const isAllowedType = [
    collectiveTypes.COLLECTIVE,
    collectiveTypes.EVENT,
    collectiveTypes.FUND,
    collectiveTypes.PROJECT,
  ].includes(collective.type);
  const isActiveHost = collective.type === collectiveTypes.ORGANIZATION && collective.isActive;
  if (!isAllowedType && !isActiveHost) {
    throw new ValidationFailed(
      'Expenses can only be submitted to Collectives, Events, Funds, Projects and active Hosts.',
    );
  }

  // Let submitter customize the currency
  let currency = collective.currency;
  if (expenseData.currency && expenseData.currency !== currency) {
    if (!hasMultiCurrency(collective, collective.host)) {
      throw new FeatureNotSupportedForCollective('Multi-currency expenses are not enabled for this account');
    } else {
      currency = expenseData.currency;
    }
  }

  // Load the payee profile
  const fromCollective = expenseData.fromCollective || (await remoteUser.getCollective());
  if (!remoteUser.isAdminOfCollective(fromCollective)) {
    throw new ValidationFailed('You must be an admin of the account to submit an expense in its name');
  } else if (!fromCollective.canBeUsedAsPayoutProfile()) {
    throw new ValidationFailed('This account cannot be used for payouts');
  }

  // Update payee's location
  if (!(expenseData.payeeLocation?.address || expenseData.payeeLocation?.address1) && fromCollective.location) {
    expenseData.payeeLocation = pick(fromCollective.location, [
      'formattedAddress',
      'country',
      'address1',
      'address2',
      'postalCode',
      'zone',
      'city',
    ]);
  } else {
    const structuredLocation = expenseData.payeeLocation?.structured || {
      address1: expenseData.payeeLocation?.address1,
      address2: expenseData.payeeLocation?.address2,
      postalCode: expenseData.payeeLocation?.postalCode,
      city: expenseData.payeeLocation?.city,
      zone: expenseData.payeeLocation?.zone,
      country: expenseData.payeeLocation?.country,
    };

    /* Update payee's location for USER's if it is not of new format
     * Only for USER's, since other Collective types have public location fields, and exposing payeeLocation might be undesired
     */
    if (fromCollective.type === 'USER' && !fromCollective.location?.address1 && !expenseData.payeeLocation?.address) {
      await fromCollective.setLocation(structuredLocation);
    }

    // Create formatted address
    const formattedAddress =
      expenseData.payeeLocation?.address || (await formatAddress(structuredLocation, { lineDivider: 'newline' }));

    expenseData.payeeLocation = {
      ...expenseData.payeeLocation,
      formattedAddress,
    };
  }

  // Get or create payout method
  const payoutMethod = await getPayoutMethodFromExpenseData(expenseData, remoteUser, fromCollective, null);

  // Create and validate TransferWise recipient
  let recipient;
  if (payoutMethod?.type === PayoutMethodTypes.BANK_ACCOUNT) {
    const payoutMethodData = <BankAccountPayoutMethodData>payoutMethod.data;
    const accountHolderName = payoutMethodData?.accountHolderName;
    const legalName = <string>expenseData.fromCollective.legalName;
    if (accountHolderName && legalName && !isAccountHolderNameAndLegalNameMatch(accountHolderName, legalName)) {
      logger.warn('The legal name should match the bank account holder name (${accountHolderName} ≠ ${legalName})');
    }

    const connectedAccounts =
      collective.host && (await collective.host.getConnectedAccounts({ where: { service: 'transferwise' } }));
    if (connectedAccounts?.[0]) {
      paymentProviders.transferwise.validatePayoutMethod(connectedAccounts[0], payoutMethod);
      recipient = await paymentProviders.transferwise.createRecipient(connectedAccounts[0], payoutMethod);
    }
  }

  const expense = await sequelize.transaction(async t => {
    // Create expense
    const createdExpense = await models.Expense.create(
      {
        ...(<Pick<ExpenseData, ExpenseEditableFieldsUnion>>pick(expenseData, EXPENSE_EDITABLE_FIELDS)),
        currency,
        tags: expenseData.tags,
        status: statuses.PENDING,
        CollectiveId: collective.id,
        FromCollectiveId: fromCollective.id,
        lastEditedById: remoteUser.id,
        UserId: remoteUser.id,
        incurredAt: expenseData.incurredAt || new Date(),
        PayoutMethodId: payoutMethod && payoutMethod.id,
        legacyPayoutMethod: models.Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
        amount: computeTotalAmountForExpense(itemsData, taxes),
        data: { recipient, taxes },
      },
      { transaction: t },
    );

    // Create items
    createdExpense.items = await Promise.all(
      itemsData.map(attachmentData => {
        return models.ExpenseItem.createFromData(attachmentData, remoteUser, createdExpense, t);
      }),
    );

    // Create attached files
    createdExpense.attachedFiles = await createAttachedFiles(createdExpense, expenseData.attachedFiles, remoteUser, t);

    return createdExpense;
  });

  expense.user = remoteUser;
  expense.collective = collective;
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_CREATED, remoteUser);
  return expense;
}

/** Returns true if the expense should by put back to PENDING after this update */
export const changesRequireStatusUpdate = (
  expense: Expense,
  newExpenseData: ExpenseData,
  hasItemsChanges: boolean,
  hasPayoutChanges: boolean,
): boolean => {
  const updatedValues = { ...expense.dataValues, ...newExpenseData };
  const hasAmountChanges = typeof updatedValues.amount !== 'undefined' && updatedValues.amount !== expense.amount;
  const isPaidOrProcessingCharge =
    expense.type === EXPENSE_TYPE.CHARGE && ['PAID', 'PROCESSING'].includes(expense.status);

  if (isPaidOrProcessingCharge && !hasAmountChanges) {
    return false;
  }
  return hasItemsChanges || hasAmountChanges || hasPayoutChanges;
};

/** Returns infos about the changes made to items */
export const getItemsChanges = async (
  existingItems: ExpenseItem[],
  expenseData: ExpenseData,
): Promise<[boolean, [Record<string, unknown>[], ExpenseItem[], Record<string, unknown>[]]]> => {
  if (expenseData.items) {
    const itemsDiff = models.ExpenseItem.diffDBEntries(existingItems, expenseData.items);
    const hasItemChanges = flatten(<unknown[]>itemsDiff).length > 0;
    return [hasItemChanges, itemsDiff];
  } else {
    return [false, [[], [], []]];
  }
};

/*
 * Validate the account holder name against the legal name. Following cases are considered a match,
 *
 * 1) Punctuation are ignored; "Evil Corp, Inc" and "Evil Corp, Inc." are considered a match.
 * 2) Accents are ignored; "François" and "Francois" are considered a match.
 * 3) The first name and last name order is ignored; "Benjamin Piouffle" and "Piouffle Benjamin" is considered a match.
 * 4) If one of account holder name or legal name is not defined then this function returns true.
 */
export const isAccountHolderNameAndLegalNameMatch = (accountHolderName: string, legalName: string): boolean => {
  // Ignore 501(c)(3) in both account holder name and legal name
  legalName = legalName.replace(/501\(c\)\(3\)/g, '');
  accountHolderName = accountHolderName.replace(/501\(c\)\(3\)/g, '');

  const namesArray = legalName.trim().split(' ');
  let legalNameReversed;
  if (namesArray.length === 2) {
    const firstName = namesArray[0];
    const lastName = namesArray[1];
    legalNameReversed = `${lastName} ${firstName}`;
  }
  return !(
    accountHolderName.localeCompare(legalName, undefined, {
      sensitivity: 'base',
      ignorePunctuation: true,
    }) &&
    accountHolderName.localeCompare(legalNameReversed, undefined, {
      sensitivity: 'base',
      ignorePunctuation: true,
    })
  );
};

export async function editExpense(req: express.Request, expenseData: ExpenseData, options = {}): Promise<Expense> {
  const remoteUser = options?.['overrideRemoteUser'] || req.remoteUser;
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to edit an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  const expense = await models.Expense.findByPk(expenseData.id, {
    include: [
      {
        model: models.Collective,
        as: 'collective',
        required: true,
        include: [
          { association: 'host', required: false },
          { association: 'parent', required: false },
        ],
      },
      { model: models.Collective, as: 'fromCollective' },
      { model: models.ExpenseAttachedFile, as: 'attachedFiles' },
      { model: models.PayoutMethod },
      { association: 'items' },
    ],
  });

  if (!expense) {
    throw new NotFound('Expense not found');
  }

  const { collective } = expense;
  const { host } = collective;
  const isPaidCreditCardCharge =
    expense.type === EXPENSE_TYPE.CHARGE &&
    ['PAID', 'PROCESSING'].includes(expense.status) &&
    Boolean(expense.VirtualCardId);

  // Check if 2FA is enforced on any of the account remote user is admin of, unless it's a paid credit card charge
  // since we strictly limit the fields that can be updated in that case
  if (req.remoteUser && !isPaidCreditCardCharge) {
    const accountsFor2FA = [expense.fromCollective, collective, host].filter(Boolean);
    await twoFactorAuthLib.enforceForAccountsUserIsAdminOf(req, accountsFor2FA);
  }

  // When changing the type, we must make sure that the new type is allowed
  if (expenseData.type && expenseData.type !== expense.type) {
    checkExpenseType(expenseData.type, collective, collective.parent, collective.host);
  }

  const [hasItemChanges, itemsDiff] = await getItemsChanges(expense.items, expenseData);
  const taxes = expenseData.tax || (expense.data?.taxes as TaxDefinition[]) || [];
  const expenseType = expenseData.type || expense.type;
  checkTaxes(expense.collective, expense.collective.host, expenseType, taxes);

  const modifiedFields = Object.keys(omitBy(expenseData, (value, key) => key === 'id' || isNil(value)));
  if (isEqual(modifiedFields, ['tags'])) {
    // Special mode when editing **only** tags: we don't care about the expense status there
    if (!(await canEditExpenseTags(req, expense))) {
      throw new Unauthorized("You don't have permission to edit tags for this expense");
    }

    return expense.update({ tags: expenseData.tags });
  }

  if (!options?.['skipPermissionCheck'] && !(await canEditExpense(req, expense))) {
    throw new Unauthorized("You don't have permission to edit this expense");
  }

  if (isPaidCreditCardCharge && !hasItemChanges) {
    throw new ValidationFailed(
      'You need to include Expense Items when adding missing information to card charge expenses',
    );
  }

  if (size(expenseData.attachedFiles) > 15) {
    throw new ValidationFailed('The number of files that you can attach to an expense is limited to 15');
  }

  // Load the payee profile
  const fromCollective = expenseData.fromCollective || expense.fromCollective;
  if (expenseData.fromCollective && expenseData.fromCollective.id !== expense.fromCollective.id) {
    if (!options?.['skipPermissionCheck'] && !remoteUser.isAdminOfCollective(fromCollective)) {
      throw new ValidationFailed('You must be an admin of the account to submit an expense in its name');
    } else if (!fromCollective.canBeUsedAsPayoutProfile()) {
      throw new ValidationFailed('This account cannot be used for payouts');
    }
  }

  /* Let's take the opportunity to update collective's location
      Only for USER's since other Collective types have public location fields and payeeLocation is private by default */
  if (expenseData.payeeLocation && !fromCollective.location && fromCollective.type === 'USER') {
    await fromCollective.setLocation(expenseData.payeeLocation);
  }

  const cleanExpenseData = <Pick<ExpenseData, ExpenseEditableFieldsUnion>>(
    pick(expenseData, isPaidCreditCardCharge ? EXPENSE_PAID_CHARGE_EDITABLE_FIELDS : EXPENSE_EDITABLE_FIELDS)
  );

  // Let submitter customize the currency
  const isChangingCurrency = expenseData.currency && expenseData.currency !== expense.currency;
  if (isChangingCurrency && expenseData.currency !== collective.currency && !hasMultiCurrency(collective, host)) {
    throw new FeatureNotSupportedForCollective('Multi-currency expenses are not enabled for this account');
  }

  let payoutMethod = await expense.getPayoutMethod();
  let feesPayer = expense.feesPayer;

  // Validate bank account payout method
  if (payoutMethod?.type === PayoutMethodTypes.BANK_ACCOUNT) {
    const payoutMethodData = <BankAccountPayoutMethodData>payoutMethod.data;
    const accountHolderName = payoutMethodData?.accountHolderName;
    const legalName = <string>expenseData.fromCollective.legalName;
    if (accountHolderName && legalName && !isAccountHolderNameAndLegalNameMatch(accountHolderName, legalName)) {
      logger.warn('The legal name should match the bank account holder name (${accountHolderName} ≠ ${legalName})');
    }
  }
  const updatedExpense = await sequelize.transaction(async transaction => {
    // Update payout method if we get new data from one of the param for it
    if (
      !isPaidCreditCardCharge &&
      expenseData.payoutMethod !== undefined &&
      expenseData.payoutMethod?.id !== expense.PayoutMethodId
    ) {
      payoutMethod = await getPayoutMethodFromExpenseData(expenseData, remoteUser, fromCollective, transaction);

      // Reset fees payer when changing the payout method and the new one doesn't support it
      if (feesPayer === ExpenseFeesPayer.PAYEE && !models.PayoutMethod.typeSupportsFeesPayer(payoutMethod?.type)) {
        feesPayer = ExpenseFeesPayer.COLLECTIVE;
      }
    }

    // Update items
    if (hasItemChanges) {
      const simulatedItemsUpdate = simulateDBEntriesDiff(expense.items, itemsDiff);
      checkExpenseItems(expenseType, simulatedItemsUpdate, taxes);
      const [newItemsData, itemsToRemove, itemsToUpdate] = itemsDiff;
      await Promise.all(<Promise<void>[]>[
        // Delete
        ...itemsToRemove.map(item => {
          return item.destroy({ transaction });
        }),
        // Create
        ...newItemsData.map(itemData => {
          return models.ExpenseItem.createFromData(itemData, remoteUser, expense, transaction);
        }),
        // Update
        ...itemsToUpdate.map(itemData => {
          return models.ExpenseItem.updateFromData(itemData, transaction);
        }),
      ]);

      // Reload items
      expense.items = await expense.getItems({ transaction, order: [['id', 'ASC']] });
    }

    // Update expense
    // When updating amount, attachment or payoutMethod, we reset its status to PENDING
    const PayoutMethodId = payoutMethod ? payoutMethod.id : null;
    const shouldUpdateStatus = changesRequireStatusUpdate(
      expense,
      expenseData,
      hasItemChanges,
      PayoutMethodId !== expense.PayoutMethodId,
    );

    // Update attached files
    if (expenseData.attachedFiles) {
      const [newAttachedFiles, removedAttachedFiles, updatedAttachedFiles] = models.ExpenseAttachedFile.diffDBEntries(
        expense.attachedFiles,
        expenseData.attachedFiles,
      );

      await createAttachedFiles(expense, newAttachedFiles, remoteUser, transaction);
      await Promise.all(removedAttachedFiles.map((file: ExpenseAttachedFile) => file.destroy()));
      await Promise.all(
        updatedAttachedFiles.map((file: Record<string, unknown>) =>
          models.ExpenseAttachedFile.update({ url: file.url }, { where: { id: file.id, ExpenseId: expense.id } }),
        ),
      );
    }

    let status = expense.status;
    if (shouldUpdateStatus) {
      status = 'PENDING';
    } else if (status === 'INCOMPLETE') {
      status = 'APPROVED';
    }

    const updatedExpenseProps = {
      ...cleanExpenseData,
      data: !expense.data ? null : cloneDeep(expense.data),
      amount: computeTotalAmountForExpense(expense.items, taxes),
      lastEditedById: remoteUser.id,
      incurredAt: expenseData.incurredAt || new Date(),
      status,
      FromCollectiveId: fromCollective.id,
      PayoutMethodId: PayoutMethodId,
      legacyPayoutMethod: models.Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
      tags: cleanExpenseData.tags,
    };

    if (isPaidCreditCardCharge) {
      set(updatedExpenseProps, 'data.missingDetails', false);
    }
    if (!isEqual(expense.data?.taxes, taxes)) {
      set(updatedExpenseProps, 'data.taxes', taxes);
    }
    return expense.update(updatedExpenseProps, { transaction });
  });

  if (isPaidCreditCardCharge) {
    if (cleanExpenseData.description) {
      await models.Transaction.update(
        { description: cleanExpenseData.description },
        { where: { ExpenseId: updatedExpense.id } },
      );
    }

    // Auto Resume Virtual Card
    if (host?.settings?.virtualcards?.autopause) {
      const virtualCard = await expense.getVirtualCard();
      const expensesMissingReceipts = await virtualCard.getExpensesMissingDetails();
      if (virtualCard.isPaused() && expensesMissingReceipts.length === 0) {
        await virtualCard.resume();
      }
    }
  }

  await updatedExpense.createActivity(activities.COLLECTIVE_EXPENSE_UPDATED, remoteUser);
  return updatedExpense;
}

export async function deleteExpense(req: express.Request, expenseId: number): Promise<Expense> {
  const { remoteUser } = req;
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to delete an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  const expense = await models.Expense.findByPk(expenseId, {
    include: [{ model: models.Collective, as: 'collective' }],
  });

  if (!expense) {
    throw new NotFound('Expense not found');
  }

  if (!(await canDeleteExpense(req, expense))) {
    throw new Unauthorized(
      "You don't have permission to delete this expense or it needs to be rejected before being deleted",
    );
  }

  await expense.destroy();
  return expense.reload({ paranoid: false });
}

/** Helper that finishes the process of paying an expense */
async function markExpenseAsPaid(expense, remoteUser, isManualPayout = false): Promise<Expense> {
  debug('update expense status to PAID', expense.id);
  await expense.setPaid(remoteUser.id);
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_PAID, remoteUser, { isManualPayout });
  return expense;
}

async function payExpenseWithPayPalAdaptive(remoteUser, expense, host, paymentMethod, toPaypalEmail, fees = {}) {
  debug('payExpenseWithPayPalAdaptive', expense.id);

  if (expense.currency !== expense.collective.currency) {
    throw new Error(
      'Multi-currency expenses are not supported by the legacy PayPal adaptive implementation. Please migrate to PayPal payouts: https://docs.opencollective.com/help/fiscal-hosts/payouts/payouts-with-paypal',
    );
  }

  if (parseToBoolean(process.env.DISABLE_PAYPAL_ADAPTIVE) && !remoteUser.isRoot()) {
    throw new Error('PayPal adaptive is currently under maintenance. Please try again later.');
  }

  try {
    const paymentResponse = await paymentProviders.paypal.types['adaptive'].pay(
      expense.collective,
      expense,
      toPaypalEmail,
      paymentMethod.token,
    );

    debug(JSON.stringify(paymentResponse));
    const { createPaymentResponse, executePaymentResponse } = paymentResponse;

    switch (executePaymentResponse.paymentExecStatus) {
      case 'COMPLETED':
        break;

      case 'CREATED':
        /*
         * When we don't provide a preapprovalKey (paymentMethod.token) to payServices['paypal'](),
         * it creates a payKey that we can use to redirect the user to PayPal.com to manually approve that payment
         * TODO We should handle that case on the frontend
         */
        throw new errors.BadRequest(
          `Please approve this payment manually on ${createPaymentResponse.paymentApprovalUrl}`,
        );

      case 'ERROR':
        // Backward compatible error message parsing
        // eslint-disable-next-line no-case-declarations
        const errorMessage =
          executePaymentResponse.payErrorList?.payError?.[0].error?.message ||
          executePaymentResponse.payErrorList?.[0].error?.message;
        throw new errors.ServerError(
          `Error while paying the expense with PayPal: "${errorMessage}". Please contact support@opencollective.com or pay it manually through PayPal.`,
        );

      default:
        throw new errors.ServerError(
          `Error while paying the expense with PayPal. Please contact support@opencollective.com or pay it manually through PayPal.`,
        );
    }

    // Warning senderFees can be null
    let senderFees = createPaymentResponse.defaultFundingPlan.senderFees?.amount;
    if (senderFees) {
      senderFees = floatAmountToCents(parseFloat(senderFees));
    } else {
      // PayPal stopped providing senderFees in the response, we need to compute it ourselves
      // We don't have to check for feesPayer here because it is not supported for PayPal adaptive
      const { fundingAmount } = createPaymentResponse.defaultFundingPlan;
      const amountPaidByTheHost = floatAmountToCents(parseFloat(fundingAmount.amount));
      const amountReceivedByPayee = expense.amount;
      senderFees = Math.round(amountPaidByTheHost - amountReceivedByPayee) || 0;

      // No example yet, but we want to know if this ever happens
      if (fundingAmount.code !== expense.currency) {
        reportMessageToSentry(`PayPal adaptive got a funding amount with a different currency than the expense`, {
          severity: 'error',
        });
      }
    }

    const currencyConversion = createPaymentResponse.defaultFundingPlan.currencyConversion || { exchangeRate: 1 };
    const hostCurrencyFxRate = 1 / parseFloat(currencyConversion.exchangeRate); // paypal returns a float from host.currency to expense.currency
    fees['paymentProcessorFeeInHostCurrency'] = Math.round(hostCurrencyFxRate * senderFees);

    // Adaptive does not work with multi-currency expenses, so we can safely assume that expense.currency = collective.currency
    await createTransactionsFromPaidExpense(host, expense, fees, hostCurrencyFxRate, paymentResponse, paymentMethod);
    const updatedExpense = await markExpenseAsPaid(expense, remoteUser);
    await paymentMethod.updateBalance();
    return updatedExpense;
  } catch (err) {
    debug('paypal> error', JSON.stringify(err, null, '  '));
    if (
      err.message.indexOf('The total amount of all payments exceeds the maximum total amount for all payments') !== -1
    ) {
      throw new ValidationFailed(
        'Not enough funds in your existing Paypal preapproval. Please refill your PayPal payment balance.',
      );
    } else {
      reportErrorToSentry(err);
      throw new BadRequest(err.message);
    }
  }
}

const matchFxRateWithCurrency = (
  expectedSourceCurrency: string,
  expectedTargetCurrency: string,
  rateSourceCurrency: string,
  rateTargetCurrency: string,
  rate: number | null | undefined,
) => {
  if (!rate) {
    return null;
  } else if (expectedSourceCurrency === rateSourceCurrency && expectedTargetCurrency === rateTargetCurrency) {
    return rate;
  } else if (expectedSourceCurrency === rateTargetCurrency && expectedTargetCurrency === rateSourceCurrency) {
    return 1 / rate;
  }
};

export const getWiseFxRateInfoFromExpenseData = (
  expense,
  expectedSourceCurrency: string,
  expectedTargetCurrency: string,
) => {
  if (expectedSourceCurrency === expectedTargetCurrency) {
    return { value: 1 };
  }

  const wiseInfo: WiseTransfer | WiseQuote | WiseQuoteV2 = expense.data?.transfer || expense.data?.quote;
  if (wiseInfo?.rate) {
    // In this context, the source currency is always the Host currency and the target currency is the Payee currency
    const wiseSourceCurrency = wiseInfo['sourceCurrency'] || wiseInfo['source'];
    const wiseTargetCurrency = wiseInfo['targetCurrency'] || wiseInfo['target'];
    // This makes the fxRate be the rate for Host -> Payee
    const fxRate = matchFxRateWithCurrency(
      expectedSourceCurrency,
      expectedTargetCurrency,
      wiseSourceCurrency,
      wiseTargetCurrency,
      wiseInfo.rate,
    );
    if (fxRate) {
      return {
        value: fxRate,
        date: new Date(wiseInfo['created'] || wiseInfo['createdTime']), // "created" for transfers, "createdTime" for quotes
        isFinal: Boolean(expense.data?.transfer),
      };
    }
  }
};

export async function setTransferWiseExpenseAsProcessing({ host, expense, data, feesInHostCurrency, remoteUser }) {
  await expense.update({ HostCollectiveId: host.id, data: { ...expense.data, ...data, feesInHostCurrency } });
  await expense.setProcessing(remoteUser.id);
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_PROCESSING, remoteUser, {
    message: expense.data?.paymentOption?.formattedEstimatedDelivery
      ? `ETA: ${expense.data.paymentOption.formattedEstimatedDelivery}`
      : undefined,
  });
  return expense;
}

/**
 * A soft lock on expenses, that works by adding a `isLocked` flag on expense's data
 */
const lockExpense = async (id, callback) => {
  // Lock expense
  await sequelize.transaction(async sqlTransaction => {
    const expense = await models.Expense.findByPk(id, { lock: true, transaction: sqlTransaction });

    if (!expense) {
      throw new Unauthorized('Expense not found');
    } else if (expense.data?.isLocked) {
      throw new Error('This expense is already been processed, please try again later');
    } else {
      return expense.update({ data: { ...expense.data, isLocked: true } }, { transaction: sqlTransaction });
    }
  });

  try {
    return await callback();
  } finally {
    // Unlock expense
    const expense = await models.Expense.findByPk(id);
    await expense.update({ data: { ...expense.data, isLocked: false } });
  }
};

type FeesArgs = {
  paymentProcessorFeeInCollectiveCurrency?: number;
  hostFeeInCollectiveCurrency?: number;
  platformFeeInCollectiveCurrency?: number;
};

/**
 * Estimates the fees for an expense
 */
export const getExpenseFees = async (
  expense,
  host,
  { fees = {}, payoutMethod, useExistingWiseData = false },
): Promise<{
  feesInHostCurrency: {
    paymentProcessorFeeInHostCurrency: number;
    hostFeeInHostCurrency: number;
    platformFeeInHostCurrency: number;
  };
  feesInExpenseCurrency: {
    paymentProcessorFee?: number;
    hostFee?: number;
    platformFee?: number;
  };
  feesInCollectiveCurrency: FeesArgs;
}> => {
  const resultFees = { ...fees };
  const feesInHostCurrency = {
    paymentProcessorFeeInHostCurrency: undefined,
    hostFeeInHostCurrency: undefined,
    platformFeeInHostCurrency: undefined,
  };

  if (!expense.collective) {
    expense.collective = await models.Collective.findByPk(expense.CollectiveId);
  }

  const collectiveToHostFxRate = await getFxRate(expense.collective.currency, host.currency);
  const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();

  if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT) {
    const [connectedAccount] = await host.getConnectedAccounts({
      where: { service: 'transferwise', deletedAt: null },
    });
    if (!connectedAccount) {
      throw new Error('Host is not connected to Transferwise');
    }

    const existingQuote = expense.data?.quote;
    const existingPaymentOption = existingQuote?.paymentOption;
    if (
      useExistingWiseData &&
      existingQuote &&
      existingQuote.sourceCurrency === host.currency &&
      existingQuote.targetCurrency === payoutMethod.unfilteredData.currency &&
      existingPaymentOption
    ) {
      resultFees['paymentProcessorFeeInCollectiveCurrency'] = floatAmountToCents(
        existingPaymentOption.fee.total / collectiveToHostFxRate,
      );
    } else {
      const quote = await paymentProviders.transferwise.getTemporaryQuote(connectedAccount, payoutMethod, expense);
      const paymentOption = quote.paymentOptions.find(p => p.payIn === 'BALANCE' && p.payOut === quote.payOut);
      if (!paymentOption) {
        throw new BadRequest(`Could not find available payment option for this transaction.`, null, quote);
      }
      // Quote is always in host currency
      resultFees['paymentProcessorFeeInCollectiveCurrency'] = floatAmountToCents(
        paymentOption.fee.total / collectiveToHostFxRate,
      );
    }
  } else if (payoutMethodType === PayoutMethodTypes.PAYPAL) {
    resultFees['paymentProcessorFeeInCollectiveCurrency'] = await paymentProviders.paypal.types['adaptive'].fees({
      amount: expense.amount,
      currency: expense.collective.currency,
      host,
    });
  }

  // Build fees in host currency
  feesInHostCurrency.paymentProcessorFeeInHostCurrency = Math.round(
    collectiveToHostFxRate * (<number>resultFees['paymentProcessorFeeInCollectiveCurrency'] || 0),
  );
  feesInHostCurrency.hostFeeInHostCurrency = Math.round(
    collectiveToHostFxRate * (<number>fees['hostFeeInCollectiveCurrency'] || 0),
  );
  feesInHostCurrency.platformFeeInHostCurrency = Math.round(
    collectiveToHostFxRate * (<number>resultFees['platformFeeInCollectiveCurrency'] || 0),
  );

  if (!resultFees['paymentProcessorFeeInCollectiveCurrency']) {
    resultFees['paymentProcessorFeeInCollectiveCurrency'] = 0;
  }

  // Build fees in expense currency
  let feesInExpenseCurrency = {};
  if (expense.currency === expense.collective.currency) {
    feesInExpenseCurrency = {
      paymentProcessorFee: resultFees['paymentProcessorFeeInCollectiveCurrency'],
      hostFee: resultFees['hostFeeInCollectiveCurrency'],
      platformFee: resultFees['platformFeeInCollectiveCurrency'],
    };
  } else {
    const collectiveToExpenseFxRate = await getFxRate(expense.collective.currency, expense.currency);
    const applyCollectiveToExpenseFxRate = (amount: number) => Math.round((amount || 0) * collectiveToExpenseFxRate);
    feesInExpenseCurrency = {
      paymentProcessorFee: applyCollectiveToExpenseFxRate(resultFees['paymentProcessorFeeInCollectiveCurrency']),
      hostFee: applyCollectiveToExpenseFxRate(resultFees['hostFeeInCollectiveCurrency']),
      platformFee: applyCollectiveToExpenseFxRate(resultFees['platformFeeInCollectiveCurrency']),
    };
  }

  return { feesInCollectiveCurrency: resultFees, feesInHostCurrency, feesInExpenseCurrency };
};

/**
 * Check if the collective balance is enough to pay the expense. Throws if not.
 */
export const checkHasBalanceToPayExpense = async (
  host,
  expense,
  payoutMethod,
  {
    forceManual = false,
    manualFees = {},
    useExistingWiseData = false,
    totalAmountPaidInHostCurrency = undefined,
    paymentProcessorFeeInHostCurrency = undefined,
  } = {},
) => {
  const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();
  const balanceInCollectiveCurrency = await expense.collective.getBalanceWithBlockedFunds();
  const isSameCurrency = expense.currency === expense.collective.currency;

  if (expense.feesPayer === 'PAYEE') {
    assert(
      models.PayoutMethod.typeSupportsFeesPayer(payoutMethodType),
      'Putting the payment processor fees on the payee is only supported for bank accounts and manual payouts at the moment',
    );
    assert(
      expense.currency === expense.collective.currency,
      'Cannot put the payment processor fees on the payee when the expense currency is not the same as the collective currency',
    );
  }

  if (forceManual) {
    assert(totalAmountPaidInHostCurrency >= 0, 'Total amount paid must be positive');
    const collectiveToHostFxRate = await getFxRate(expense.collective.currency, host.currency);
    const balanceInHostCurrency = Math.round(balanceInCollectiveCurrency * collectiveToHostFxRate);
    if (balanceInHostCurrency < totalAmountPaidInHostCurrency) {
      throw new Error(
        `Collective does not have enough funds to pay this expense. Current balance: ${formatCurrency(
          balanceInHostCurrency,
          host.currency,
        )}, Expense amount: ${formatCurrency(balanceInHostCurrency, host.currency)}`,
      );
    }
    return {
      feesInCollectiveCurrency: {},
      feesInHostCurrency: {
        paymentProcessorFeeInHostCurrency,
      },
      feesInExpenseCurrency: {},
    };
  }

  const exchangeStats =
    !isSameCurrency && (await models.CurrencyExchangeRate.getPairStats(expense.collective.currency, expense.currency));

  // Ensure the collective has enough funds to pay the expense, with an error margin of 2σ (standard deviations) the exchange rate of past 5 days
  // to account for fluctuating rates. If no exchange rate is available, fallback to the 20% rule.
  const assertMinExpectedBalance = (amountToPayInExpenseCurrency, feesInExpenseCurrency?) => {
    let defaultErrorMessage = `Collective does not have enough funds ${
      feesInExpenseCurrency ? 'to cover for the fees of this payment method' : 'to pay this expense'
    }. Current balance: ${formatCurrency(
      balanceInCollectiveCurrency,
      expense.collective.currency,
    )}, Expense amount: ${formatCurrency(expense.amount, expense.currency)}`;
    if (feesInExpenseCurrency) {
      defaultErrorMessage += `, Estimated ${payoutMethodType} fees: ${formatCurrency(
        feesInExpenseCurrency,
        expense.currency,
      )}`;
    }
    if (isSameCurrency) {
      if (balanceInCollectiveCurrency < amountToPayInExpenseCurrency) {
        throw new ValidationFailed(`${defaultErrorMessage}.`);
      }
    } else if (isNumber(exchangeStats?.latestRate)) {
      const rate = exchangeStats.latestRate - exchangeStats.stddev * 2;
      const safeAmount = Math.round(amountToPayInExpenseCurrency / rate);
      if (balanceInCollectiveCurrency < safeAmount) {
        throw new ValidationFailed(
          `${defaultErrorMessage}. For expenses submitted in a different currency than the collective, an error margin is applied to accommodate for fluctuations. The maximum amount that can be paid is ${formatCurrency(
            Math.round(balanceInCollectiveCurrency * rate),
            expense.currency,
          )}.`,
        );
      }
    } else {
      const safeAmount = Math.round(amountToPayInExpenseCurrency * 1.2);
      if (balanceInCollectiveCurrency < safeAmount) {
        throw new ValidationFailed(
          `${defaultErrorMessage}. For expenses submitted in a different currency than the collective, an error margin is applied to accommodate for fluctuations. The maximum amount that can be paid is ${formatCurrency(
            Math.round(balanceInCollectiveCurrency / 1.2),
            expense.collective.currency,
          )}.`,
        );
      }
    }
  };

  // Check base balance before fees
  assertMinExpectedBalance(expense.amount);

  const { feesInHostCurrency, feesInCollectiveCurrency, feesInExpenseCurrency } = await getExpenseFees(expense, host, {
    fees: manualFees,
    payoutMethod,
    useExistingWiseData,
  });

  // Estimate the total amount to pay from the collective, based on who's supposed to pay the fee
  let totalAmountToPay;
  if (expense.feesPayer === 'COLLECTIVE') {
    totalAmountToPay = expense.amount + feesInExpenseCurrency.paymentProcessorFee;
  } else if (expense.feesPayer === 'PAYEE') {
    totalAmountToPay = expense.amount; // Ignore the fee as it will be deduced from the payee
  } else {
    throw new Error(`Expense fee payer "${expense.feesPayer}" not supported yet`);
  }

  // Ensure the collective has enough funds to cover the fees for this expense, with an error margin of 20% of the expense amount
  // to account for fluctuating rates. Example: to pay for a $100 expense in euros, the collective needs to have at least $120.
  assertMinExpectedBalance(totalAmountToPay, feesInExpenseCurrency.paymentProcessorFee);

  return { feesInCollectiveCurrency, feesInExpenseCurrency, feesInHostCurrency, totalAmountToPay };
};

type PayExpenseArgs = {
  id: number;
  forceManual?: boolean;
  feesPayer?: 'COLLECTIVE' | 'PAYEE'; // Defaults to COLLECTIVE
  paymentProcessorFeeInHostCurrency?: number; // Defaults to 0
  totalAmountPaidInHostCurrency?: number;
};

/**
 * Pay an expense based on the payout method defined in the Expense object
 * @PRE: fees { id, paymentProcessorFeeInCollectiveCurrency, hostFeeInCollectiveCurrency, platformFeeInCollectiveCurrency }
 * Note: some payout methods like PayPal will automatically define `paymentProcessorFeeInCollectiveCurrency`
 */
export async function payExpense(req: express.Request, args: PayExpenseArgs): Promise<Expense> {
  const { remoteUser } = req;
  const expenseId = args.id;
  const forceManual = Boolean(args.forceManual);

  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to pay an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  const expense = await lockExpense(args.id, async () => {
    const expense = await models.Expense.findByPk(expenseId, {
      include: [
        { model: models.Collective, as: 'collective' },
        { model: models.Collective, as: 'fromCollective' },
      ],
    });
    if (!expense) {
      throw new Unauthorized('Expense not found');
    }
    if (expense.status === statuses.PAID) {
      throw new Unauthorized('Expense has already been paid');
    }
    if (expense.status === statuses.PROCESSING) {
      throw new Unauthorized(
        'Expense is currently being processed, this means someone already started the payment process',
      );
    }
    if (
      expense.status !== statuses.APPROVED &&
      // Allow errored expenses to be marked as paid
      !(expense.status === statuses.ERROR)
    ) {
      throw new Unauthorized(`Expense needs to be approved. Current status of the expense: ${expense.status}.`);
    }
    if (!(await canPayExpense(req, expense))) {
      throw new Unauthorized("You don't have permission to pay this expense");
    }
    const host = await expense.collective.getHostCollective();
    if (expense.currency !== expense.collective.currency && !hasMultiCurrency(expense.collective, host)) {
      throw new Unauthorized('Multi-currency expenses are not enabled for this collective');
    }

    if (expense.legacyPayoutMethod === 'donation') {
      throw new Error('"In kind" donations are not supported anymore');
    }

    if (args.feesPayer && args.feesPayer !== expense.feesPayer) {
      await expense.update({ feesPayer: args.feesPayer });
    }

    const totalAmountPaidInHostCurrency = args.totalAmountPaidInHostCurrency;
    const paymentProcessorFeeInHostCurrency = args.paymentProcessorFeeInHostCurrency || 0;
    const payoutMethod = await expense.getPayoutMethod();
    const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();
    const { feesInHostCurrency } = await checkHasBalanceToPayExpense(host, expense, payoutMethod, {
      forceManual,
      totalAmountPaidInHostCurrency,
      paymentProcessorFeeInHostCurrency,
      manualFees: <FeesArgs>(
        pick(args, [
          'paymentProcessorFeeInCollectiveCurrency',
          'hostFeeInCollectiveCurrency',
          'platformFeeInCollectiveCurrency',
        ])
      ),
    });

    // 2FA for payouts
    const isTwoFactorAuthenticationRequiredForPayoutMethod = [
      PayoutMethodTypes.PAYPAL,
      PayoutMethodTypes.BANK_ACCOUNT,
    ].includes(payoutMethodType);
    const hostHasPayoutTwoFactorAuthenticationEnabled = get(host, 'settings.payoutsTwoFactorAuth.enabled', false);
    const use2FARollingLimit =
      isTwoFactorAuthenticationRequiredForPayoutMethod && !forceManual && hostHasPayoutTwoFactorAuthenticationEnabled;

    const totalPaidExpensesAmountKey = `${req.remoteUser.id}_2fa_payment_limit`;
    let totalPaidExpensesAmount;

    if (use2FARollingLimit) {
      totalPaidExpensesAmount = await cache.get(totalPaidExpensesAmountKey);
      await validateExpensePayout2FALimit(req, host, expense, totalPaidExpensesAmountKey);
    } else {
      // Not using rolling limit, but still enforcing 2FA for all admins
      await twoFactorAuthLib.enforceForAccount(req, host, { onlyAskOnLogin: true });
    }

    try {
      if (forceManual) {
        await createTransactionsForManuallyPaidExpense(
          host,
          expense,
          paymentProcessorFeeInHostCurrency,
          totalAmountPaidInHostCurrency,
        );
        await expense.update({
          // Remove all fields related to a previous automatic payment
          data: omit(expense.data, ['transfer', 'quote', 'fund', 'recipient', 'paymentOption']),
        });
      } else if (payoutMethodType === PayoutMethodTypes.PAYPAL) {
        if (expense.collective.currency !== host.currency) {
          throw new Error(
            'PayPal adaptive payouts are not supported when the collective currency is different from the host currency. Please migrate to PayPal payouts: https://docs.opencollective.com/help/fiscal-hosts/payouts/payouts-with-paypal',
          );
        }

        const paypalEmail = payoutMethod.data['email'];
        let paypalPaymentMethod = null;
        try {
          paypalPaymentMethod = await host.getPaymentMethod({ service: 'paypal', type: 'adaptive' });
        } catch {
          // ignore missing paypal payment method
        }
        // If the expense has been filed with the same paypal email than the host paypal
        // then we simply mark the expense as paid
        if (paypalPaymentMethod && paypalEmail === paypalPaymentMethod.name) {
          feesInHostCurrency['paymentProcessorFeeInHostCurrency'] = 0;
          await createTransactionsFromPaidExpense(host, expense, feesInHostCurrency, 'auto', { isManual: true });
        } else if (paypalPaymentMethod) {
          return payExpenseWithPayPalAdaptive(
            remoteUser,
            expense,
            host,
            paypalPaymentMethod,
            paypalEmail,
            feesInHostCurrency,
          );
        } else {
          throw new Error('No Paypal account linked, please reconnect Paypal or pay manually');
        }
      } else if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT) {
        const [connectedAccount] = await host.getConnectedAccounts({
          where: { service: 'transferwise', deletedAt: null },
        });
        if (!connectedAccount) {
          throw new Error('Host is not connected to Transferwise');
        }

        const data = await paymentProviders.transferwise.payExpense(connectedAccount, payoutMethod, expense);

        // Early return, Webhook will mark expense as Paid when the transaction completes.
        return setTransferWiseExpenseAsProcessing({
          host,
          expense,
          data,
          feesInHostCurrency,
          remoteUser,
        });
      } else if (payoutMethodType === PayoutMethodTypes.ACCOUNT_BALANCE) {
        const payee = expense.fromCollective;
        const payeeHost = await payee.getHostCollective();
        if (!payeeHost) {
          throw new Error('The payee needs to have an Host to able to be paid on its Open Collective balance.');
        }
        if (host.id !== payeeHost.id) {
          throw new Error(
            'The payee needs to be on the same Host than the payer to be paid on its Open Collective balance.',
          );
        }
        await createTransactionsFromPaidExpense(host, expense, feesInHostCurrency, 'auto');
      } else if (expense.legacyPayoutMethod === 'manual' || expense.legacyPayoutMethod === 'other') {
        // note: we need to check for manual and other for legacy reasons
        await createTransactionsFromPaidExpense(host, expense, feesInHostCurrency, 'auto');
      }
    } catch (error) {
      if (use2FARollingLimit) {
        if (!isNil(totalPaidExpensesAmount) && totalPaidExpensesAmount !== 0) {
          cache.set(totalPaidExpensesAmountKey, totalPaidExpensesAmount - expense.amount, ROLLING_LIMIT_CACHE_VALIDITY);
        }
      }

      throw error;
    }

    return markExpenseAsPaid(expense, remoteUser, true);
  });

  return expense;
}

export async function markExpenseAsUnpaid(
  req: express.Request,
  expenseId: number,
  shouldRefundPaymentProcessorFee: boolean,
): Promise<Expense> {
  const { remoteUser } = req;

  const updatedExpense = await lockExpense(expenseId, async () => {
    if (!remoteUser) {
      throw new Unauthorized('You need to be logged in to unpay an expense');
    } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
      throw new FeatureNotAllowedForUser();
    }

    const expense = await models.Expense.findByPk(expenseId, {
      include: [
        { model: models.Collective, as: 'collective' },
        { model: models.User, as: 'User' },
        { model: models.PayoutMethod },
      ],
    });

    if (!expense) {
      throw new NotFound('No expense found');
    }

    if (!(await canMarkAsUnpaid(req, expense))) {
      throw new Unauthorized("You don't have permission to mark this expense as unpaid");
    }

    if (expense.status !== statuses.PAID) {
      throw new Unauthorized('Expense has not been paid yet');
    }

    const transaction = await models.Transaction.findOne({
      where: {
        ExpenseId: expenseId,
        RefundTransactionId: null,
        kind: TransactionKind.EXPENSE,
        isRefund: false,
      },
      include: [{ model: models.Expense }],
    });

    const paymentProcessorFeeInHostCurrency = shouldRefundPaymentProcessorFee
      ? transaction.paymentProcessorFeeInHostCurrency
      : 0;
    await libPayments.createRefundTransaction(transaction, paymentProcessorFeeInHostCurrency, null, expense.User);

    return expense.update({ status: statuses.APPROVED, lastEditedById: remoteUser.id });
  });

  await updatedExpense.createActivity(activities.COLLECTIVE_EXPENSE_MARKED_AS_UNPAID, remoteUser);
  return updatedExpense;
}

export async function quoteExpense(expense_, { req }) {
  const expense = await models.Expense.findByPk(expense_.id, {
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'fromCollective' },
    ],
  });
  const payoutMethod = await expense.getPayoutMethod();
  const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();
  if (!(await canPayExpense(req, expense))) {
    throw new Unauthorized("You don't have permission to pay this expense");
  }

  const host = await expense.collective.getHostCollective();
  if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT) {
    const [connectedAccount] = await host.getConnectedAccounts({
      where: { service: 'transferwise', deletedAt: null },
    });
    if (!connectedAccount) {
      throw new Error('Host is not connected to Transferwise');
    }

    const quote = await paymentProviders.transferwise.quoteExpense(connectedAccount, payoutMethod, expense);
    return quote;
  }
}

export const getExpenseAmountInDifferentCurrency = async (expense, toCurrency, req) => {
  // Small helper to quickly generate an Amount object with fxRate
  const buildAmount = (
    fxRatePercentage: number,
    fxRateSource: CurrencyExchangeRateSourceTypeEnum,
    isApproximate: boolean,
    date = expense.createdAt,
  ) => ({
    value: Math.round(expense.amount * fxRatePercentage),
    currency: toCurrency,
    exchangeRate: {
      value: fxRatePercentage,
      source: fxRateSource,
      fromCurrency: expense.currency,
      toCurrency: toCurrency,
      date: date || expense.createdAt,
      isApproximate,
    },
  });

  // Simple case: no conversion needed
  if (toCurrency === expense.currency) {
    return { value: expense.amount, currency: expense.currency, exchangeRate: null };
  }

  // Retrieve existing FX rate based from payment provider payload (for already paid or quoted stuff)
  const { WISE, PAYPAL, OPENCOLLECTIVE } = CurrencyExchangeRateSourceTypeEnum;
  const payoutMethod = expense.PayoutMethodId && (await req.loaders.PayoutMethod.byId.load(expense.PayoutMethodId));

  if (payoutMethod) {
    if (payoutMethod.type === PayoutMethodTypes.BANK_ACCOUNT) {
      const wiseFxRateInfo = getWiseFxRateInfoFromExpenseData(expense, expense.currency, toCurrency);
      if (wiseFxRateInfo) {
        return buildAmount(wiseFxRateInfo.value, WISE, !wiseFxRateInfo.isFinal, wiseFxRateInfo.date);
      }
    } else if (payoutMethod.type === PayoutMethodTypes.PAYPAL) {
      const currencyConversion = expense.data?.['currency_conversion'];
      if (currencyConversion) {
        const fxRate = matchFxRateWithCurrency(
          expense.currency,
          toCurrency,
          currencyConversion['from_amount']['currency'],
          currencyConversion['to_amount']['currency'],
          parseFloat(currencyConversion['exchange_rate']),
        );

        if (fxRate) {
          const date = expense.data['time_processed'] ? new Date(expense.data['time_processed']) : null;
          return buildAmount(fxRate, PAYPAL, false, date);
        }
      }
    }
  }

  // TODO: Can we retrieve something for virtual cards?

  if (expense.status === 'PAID') {
    const result = await req.loaders.Expense.expenseToHostTransactionFxRateLoader.load(expense.id);
    // If collective changed their currency since the expense was paid, we can't rely on transaction.currency
    if (!isNil(result?.rate) && (!expense.collective || expense.collective.currency === result.currency)) {
      return buildAmount(result.rate, OPENCOLLECTIVE, false, expense.createdAt);
    }
  }

  // Fallback on internal system
  const fxRate = await req.loaders.CurrencyExchangeRate.fxRate.load({ fromCurrency: expense.currency, toCurrency });
  return buildAmount(fxRate, OPENCOLLECTIVE, true);
};

/**
 * Move expenses to destination account
 * @param expenses the list of models.Expense, with the collective association preloaded
 */
export const moveExpenses = async (req: express.Request, expenses: Expense[], destinationAccount: Collective) => {
  // Root also checked in the mutation resolver, but duplicating just to be safe if someone decides to use this elsewhere
  checkRemoteUserCanRoot(req);
  if (!expenses.length) {
    return [];
  } else if (destinationAccount.type === collectiveTypes.USER) {
    throw new ValidationFailed('The "destinationAccount" must not be an USER account');
  }

  // -- Move expenses --
  const expenseIds: number[] = uniq(expenses.map(expense => expense.id));
  const recurringExpenseIds: number[] = uniq(expenses.map(expense => expense.RecurringExpenseId).filter(Boolean));
  const result = await sequelize.transaction(async dbTransaction => {
    const associatedTransactionsCount = await models.Transaction.count({
      where: { ExpenseId: expenseIds },
      transaction: dbTransaction,
    });

    if (associatedTransactionsCount > 0) {
      throw new ValidationFailed('Cannot move expenses with associated transactions');
    }

    // Moving associated models
    const [, updatedExpenses] = await models.Expense.update(
      { CollectiveId: destinationAccount.id },
      {
        transaction: dbTransaction,
        returning: true,
        where: { id: expenseIds },
        hooks: false,
      },
    );

    const [, updatedComments] = await models.Comment.update(
      { CollectiveId: destinationAccount.id },
      {
        transaction: dbTransaction,
        returning: ['id'],
        where: { ExpenseId: expenseIds },
        hooks: false,
      },
    );

    const [, updatedActivities] = await models.Activity.update(
      { CollectiveId: destinationAccount.id },
      {
        transaction: dbTransaction,
        returning: ['id'],
        where: { ExpenseId: expenseIds },
        hooks: false,
      },
    );

    let updatedRecurringExpenses = [];
    if (recurringExpenseIds.length) {
      [, updatedRecurringExpenses] = await models.RecurringExpense.update(
        { CollectiveId: destinationAccount.id },
        {
          transaction: dbTransaction,
          returning: ['id'],
          where: { id: recurringExpenseIds },
          hooks: false,
        },
      );
    }

    // Record the individual activities for moving the expenses
    await models.Activity.bulkCreate(
      updatedExpenses.map(expense => {
        const originalExpense = find(expenses, { id: expense.id });
        return {
          type: ActivityTypes.COLLECTIVE_EXPENSE_MOVED,
          UserId: req.remoteUser.id,
          UserTokenId: req.userToken?.id,
          FromCollectiveId: originalExpense.collective.id,
          CollectiveId: destinationAccount.id,
          HostCollectiveId: destinationAccount.HostCollectiveId,
          ExpenseId: expense.id,
          data: {
            expense: expense.info,
            movedFromCollective: originalExpense.collective.info,
            collective: destinationAccount.info,
          },
        };
      }),
      {
        transaction: dbTransaction,
        hooks: false, // Hooks are not playing well with `bulkCreate`, and we don't need to send any email here anyway
      },
    );

    // Record the migration log
    await models.MigrationLog.create(
      {
        type: MigrationLogType.MOVE_EXPENSES,
        description: `Moved ${updatedExpenses.length} expenses`,
        CreatedByUserId: req.remoteUser.id,
        data: {
          expenses: updatedExpenses.map(o => o.id),
          recurringExpenses: updatedRecurringExpenses.map(o => o.id),
          comments: updatedComments.map(c => c.id),
          activities: updatedActivities.map(a => a.id),
          destinationAccount: destinationAccount.id,
          previousExpenseValues: mapValues(keyBy(expenses, 'id'), expense => pick(expense, ['CollectiveId'])),
        },
      },
      { transaction: dbTransaction },
    );

    return updatedExpenses;
  });

  return result;
};

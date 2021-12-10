import debugLib from 'debug';
import express from 'express';
import { flatten, get, isEqual, isNil, omit, omitBy, pick, size } from 'lodash';

import { activities, expenseStatus, roles } from '../../constants';
import { types as collectiveTypes } from '../../constants/collectives';
import statuses from '../../constants/expense_status';
import expenseType from '../../constants/expense_type';
import FEATURE from '../../constants/feature';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import { floatAmountToCents } from '../../lib/math';
import * as libPayments from '../../lib/payments';
import { notifyTeamAboutSpamExpense } from '../../lib/spam';
import { createFromPaidExpense as createTransactionFromPaidExpense } from '../../lib/transactions';
import {
  handleTwoFactorAuthenticationPayoutLimit,
  resetRollingPayoutLimitOnFailure,
} from '../../lib/two-factor-authentication';
import { canUseFeature } from '../../lib/user-permissions';
import { formatCurrency } from '../../lib/utils';
import models, { sequelize } from '../../models';
import { ExpenseAttachedFile } from '../../models/ExpenseAttachedFile';
import { ExpenseItem } from '../../models/ExpenseItem';
import { PayoutMethodTypes } from '../../models/PayoutMethod';
import paymentProviders from '../../paymentProviders';
import { RecipientAccount as BankAccountPayoutMethodData } from '../../types/transferwise';
import { BadRequest, FeatureNotAllowedForUser, Forbidden, NotFound, Unauthorized, ValidationFailed } from '../errors';

const debug = debugLib('expenses');

const isOwner = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
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

const isCollectiveAccountant = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
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

const isCollectiveAdmin = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  if (!expense.collective) {
    expense.collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
  }

  return req.remoteUser.isAdminOfCollective(expense.collective);
};

const isHostAdmin = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
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

type PermissionCondition = (req: express.Request, expense: typeof models.Expense) => Promise<boolean>;

/**
 * Returns true if the expense meets at least one condition.
 * Always returns false for unauthenticated requests.
 */
const remoteUserMeetsOneCondition = async (
  req: express.Request,
  expense: typeof models.Expense,
  conditions: PermissionCondition[],
): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  for (const condition of conditions) {
    if (await condition(req, expense)) {
      return true;
    }
  }

  return false;
};

/** Checks if the user can see expense's attachments (items URLs, attached files) */
export const canSeeExpenseAttachments = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<boolean> => {
  return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isCollectiveAccountant, isHostAdmin]);
};

/** Checks if the user can see expense's payout method */
export const canSeeExpensePayoutMethod = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<boolean> => {
  return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isCollectiveAccountant, isHostAdmin]);
};

/** Checks if the user can see expense's payout method */
export const canSeeExpenseInvoiceInfo = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<boolean> => {
  return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isCollectiveAccountant, isHostAdmin]);
};

/** Checks if the user can see expense's payout method */
export const canSeeExpensePayeeLocation = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<boolean> => {
  return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isCollectiveAccountant, isHostAdmin]);
};

/** Checks if the user can verify or resend a draft */
export const canVerifyDraftExpense = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
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
export const canUpdateExpenseStatus = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<boolean> => {
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
export const canEditExpense = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  const nonEditableStatuses = [
    expenseStatus.PAID,
    expenseStatus.PROCESSING,
    expenseStatus.DRAFT,
    expenseStatus.SCHEDULED_FOR_PAYMENT,
  ];

  // Collective Admin can attach receipts to paid charge expenses
  if (
    expense.type === expenseType.CHARGE &&
    expense.status === expenseStatus.PAID &&
    req.remoteUser?.hasRole([roles.ADMIN], expense.CollectiveId)
  ) {
    return true;
  } else if (nonEditableStatuses.includes(expense.status)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin, isCollectiveAdmin]);
  }
};

export const canEditExpenseTags = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    return false;
  } else if (expense.status === expenseStatus.PAID) {
    // Only collective/host admins can edit tags after the expense is paid
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin, isCollectiveAdmin]);
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin, isCollectiveAdmin]);
  }
};

/**
 * Only the author or an admin of the collective or collective.host can delete an expense,
 * and only when its status is REJECTED.
 */
export const canDeleteExpense = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (![expenseStatus.REJECTED, expenseStatus.DRAFT].includes(expense.status)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isHostAdmin]);
  }
};

/**
 * Returns true if expense can be paid by user
 */
export const canPayExpense = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (![expenseStatus.APPROVED, expenseStatus.ERROR].includes(expense.status)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    return false;
  } else {
    return isHostAdmin(req, expense);
  }
};

/**
 * Returns true if expense can be approved by user
 */
export const canApprove = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (![expenseStatus.PENDING, expenseStatus.REJECTED].includes(expense.status)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin]);
  }
};

/**
 * Returns true if expense can be rejected by user
 */
export const canReject = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (![expenseStatus.PENDING, expenseStatus.UNVERIFIED].includes(expense.status)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin]);
  }
};

/**
 * Returns true if expense can be rejected by user
 */
export const canMarkAsSpam = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (![expenseStatus.REJECTED].includes(expense.status)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin]);
  }
};

/**
 * Returns true if expense can be unapproved by user
 */
export const canUnapprove = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (expense.status !== expenseStatus.APPROVED) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin]);
  }
};

/**
 * Returns true if expense can be marked as unpaid by user
 */
export const canMarkAsUnpaid = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (expense.status !== expenseStatus.PAID) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    return false;
  } else {
    return isHostAdmin(req, expense);
  }
};

/**
 * Returns true if user can comment and see others comments for this expense
 */
export const canComment = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin, isOwner]);
  }
};

export const canViewRequiredLegalDocuments = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<boolean> => {
  return remoteUserMeetsOneCondition(req, expense, [isHostAdmin, isCollectiveAdmin, isCollectiveAccountant, isOwner]);
};

export const canUnschedulePayment = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (expense.status === expenseStatus.SCHEDULED_FOR_PAYMENT && (await isHostAdmin(req, expense))) {
    return true;
  }
  return false;
};

// ---- Expense actions ----

export const approveExpense = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<typeof models.Expense> => {
  if (expense.status === expenseStatus.APPROVED) {
    return expense;
  } else if (!(await canApprove(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: expenseStatus.APPROVED, lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_APPROVED, req.remoteUser);
  return updatedExpense;
};

export const unapproveExpense = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<typeof models.Expense> => {
  if (expense.status === expenseStatus.PENDING) {
    return expense;
  } else if (!(await canUnapprove(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: expenseStatus.PENDING, lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_UNAPPROVED, req.remoteUser);
  return updatedExpense;
};

export const rejectExpense = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<typeof models.Expense> => {
  if (expense.status === expenseStatus.REJECTED) {
    return expense;
  } else if (!(await canReject(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: expenseStatus.REJECTED, lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_REJECTED, req.remoteUser);
  return updatedExpense;
};

export const markExpenseAsSpam = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<typeof models.Expense> => {
  if (expense.status === expenseStatus.SPAM) {
    return expense;
  } else if (!(await canMarkAsSpam(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: expenseStatus.SPAM, lastEditedById: req.remoteUser.id });

  // Limit the user so they can't submit expenses in the future
  const submittedByUser = await updatedExpense.getSubmitterUser();
  await submittedByUser.limitFeature(FEATURE.USE_EXPENSES);

  // We create the activity as a good practice but there is no email sent right now
  const activity = await expense.createActivity(activities.COLLECTIVE_EXPENSE_MARKED_AS_SPAM, req.remoteUser);

  // For now, we send the Slack notification directly from here as there is no framework in activities/notifications
  notifyTeamAboutSpamExpense(activity);

  return updatedExpense;
};

export const scheduleExpenseForPayment = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<typeof models.Expense> => {
  if (expense.status === expenseStatus.SCHEDULED_FOR_PAYMENT) {
    throw new BadRequest('Expense is already scheduled for payment');
  } else if (!(await canPayExpense(req, expense))) {
    throw new Forbidden("You're authenticated but you can't schedule this expense for payment");
  }

  // Warning: expense.collective is only loaded because we call `canPayExpense`
  const balance = await expense.collective.getBalanceWithBlockedFunds();
  if (expense.amount > balance) {
    throw new Unauthorized(
      `You don't have enough funds to pay this expense. Current balance: ${formatCurrency(
        balance,
        expense.collective.currency,
      )}, Expense amount: ${formatCurrency(expense.amount, expense.collective.currency)}`,
    );
  }

  // If Wise, add expense to a new batch group
  const payoutMethod = await expense.getPayoutMethod();
  if (payoutMethod.type === PayoutMethodTypes.BANK_ACCOUNT) {
    await paymentProviders.transferwise.scheduleExpenseForPayment(expense);
  }

  const updatedExpense = await expense.update({
    status: expenseStatus.SCHEDULED_FOR_PAYMENT,
    lastEditedById: req.remoteUser.id,
  });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT, req.remoteUser);
  return updatedExpense;
};

export const unscheduleExpensePayment = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<typeof models.Expense> => {
  if (!(await canUnschedulePayment(req, expense))) {
    throw new BadRequest("Expense is not scheduled for payment or you don't have authorization to unschedule it");
  }

  // If Wise, add expense to a new batch group
  const payoutMethod = await expense.getPayoutMethod();
  if (payoutMethod.type === PayoutMethodTypes.BANK_ACCOUNT) {
    await paymentProviders.transferwise.unscheduleExpenseForPayment(expense);
  }

  const updatedExpense = await expense.update({
    status: expenseStatus.APPROVED,
    lastEditedById: req.remoteUser.id,
  });
  return updatedExpense;
};

/** Compute the total amount of expense from expense items */
const getTotalAmountFromItems = items => {
  if (!items) {
    return 0;
  } else {
    return items.reduce((total, item) => {
      return total + item.amount;
    }, 0);
  }
};

/** Check expense's items values, throw if something's wrong */
const checkExpenseItems = (expenseData, items) => {
  // Check the number of items
  if (!items || items.length === 0) {
    throw new ValidationFailed('Your expense needs to have at least one item');
  } else if (items.length > 300) {
    throw new ValidationFailed('Expenses cannot have more than 300 items');
  }

  // Check amounts
  const sumItems = getTotalAmountFromItems(items);
  if (sumItems !== expenseData.amount) {
    throw new ValidationFailed(
      `The sum of all items must be equal to the total expense's amount. Expense's total is ${expenseData.amount}, but the total of items was ${sumItems}.`,
    );
  } else if (!sumItems) {
    throw new ValidationFailed(`The sum of all items must be above 0`);
  }

  // If expense is a receipt (not an invoice) then files must be attached
  if (expenseData.type === expenseType.RECEIPT) {
    const hasMissingFiles = items.some(a => !a.url);
    if (hasMissingFiles) {
      throw new ValidationFailed('Some items are missing a file');
    }
  }
};

const EXPENSE_EDITABLE_FIELDS = [
  'amount',
  'description',
  'longDescription',
  'type',
  'tags',
  'privateMessage',
  'invoiceInfo',
  'payeeLocation',
];

const EXPENSE_PAID_CHARGE_EDITABLE_FIELDS = ['description', 'tags', 'privateMessage', 'invoiceInfo'];

const getPayoutMethodFromExpenseData = async (expenseData, remoteUser, fromCollective, dbTransaction) => {
  if (expenseData.payoutMethod) {
    if (expenseData.payoutMethod.id) {
      const pm = await models.PayoutMethod.findByPk(expenseData.payoutMethod.id);
      if (!pm || !remoteUser.isAdmin(pm.CollectiveId)) {
        throw new Error("This payout method does not exist or you don't have the permission to use it");
      }
      if (
        // Payout Method from Collective
        pm.CollectiveId !== fromCollective.id &&
        // Bank Account or PayPal Payout Method from Host
        !(
          pm.CollectiveId === fromCollective.HostCollectiveId &&
          [PayoutMethodTypes.BANK_ACCOUNT, PayoutMethodTypes.PAYPAL].includes(pm.type)
        )
      ) {
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
        return models.ExpenseAttachedFile.createFromData(attachedFile.url, remoteUser, expense, transaction);
      }),
    );
  } else {
    return [];
  }
};

type ExpenseData = {
  id?: number;
  payoutMethod?: Record<string, unknown>;
  payeeLocation?: Record<string, unknown>;
  items?: Record<string, unknown>[];
  attachedFiles?: Record<string, unknown>[];
  collective?: Record<string, unknown>;
  fromCollective?: Record<string, unknown>;
  tags?: string[];
  incurredAt?: Date;
  amount?: number;
  description?: string;
};

export async function createExpense(
  remoteUser: typeof models.User | null,
  expenseData: ExpenseData,
): Promise<typeof models.Expense> {
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to create an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  if (!get(expenseData, 'collective.id')) {
    throw new Unauthorized('Missing expense.collective.id');
  }

  const isMember = Boolean(remoteUser.rolesByCollectiveId[String(expenseData.collective.id)]);
  if (expenseData.collective.settings?.['disablePublicExpenseSubmission'] && !isMember) {
    throw new Error('You must be a member of the collective to create new expense');
  }

  const itemsData = expenseData.items;

  checkExpenseItems(expenseData, itemsData);

  if (size(expenseData.attachedFiles) > 15) {
    throw new ValidationFailed('The number of files that you can attach to an expense is limited to 15');
  }

  const collective = await models.Collective.findByPk(expenseData.collective.id);
  if (!collective) {
    throw new ValidationFailed('Collective not found');
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

  // Load the payee profile
  const fromCollective = expenseData.fromCollective || (await remoteUser.getCollective());
  if (!remoteUser.isAdminOfCollective(fromCollective)) {
    throw new ValidationFailed('You must be an admin of the account to submit an expense in its name');
  } else if (!fromCollective.canBeUsedAsPayoutProfile()) {
    throw new ValidationFailed('This account cannot be used for payouts');
  }

  // Update payee's location
  if (!expenseData.payeeLocation?.address && fromCollective.location) {
    expenseData.payeeLocation = pick(fromCollective.location, ['address', 'country', 'structured']);
  } else if (
    expenseData.payeeLocation?.address &&
    (!fromCollective.location.address || !fromCollective.location.structured)
  ) {
    // Let's take the opportunity to update collective's location
    await fromCollective.update({
      address: expenseData.payeeLocation.address,
      countryISO: expenseData.payeeLocation.country,
      data: { ...fromCollective.data, address: expenseData.payeeLocation.structured },
    });
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
    const host = await collective.getHostCollective();
    const connectedAccounts = host && (await host.getConnectedAccounts({ where: { service: 'transferwise' } }));
    if (connectedAccounts?.[0]) {
      paymentProviders.transferwise.validatePayoutMethod(connectedAccounts[0], payoutMethod);
      recipient = await paymentProviders.transferwise.createRecipient(connectedAccounts[0], payoutMethod);
    }
  }

  const expense = await sequelize.transaction(async t => {
    // Create expense
    const createdExpense = await models.Expense.create(
      {
        ...pick(expenseData, EXPENSE_EDITABLE_FIELDS),
        currency: collective.currency,
        tags: expenseData.tags,
        status: statuses.PENDING,
        CollectiveId: collective.id,
        FromCollectiveId: fromCollective.id,
        lastEditedById: remoteUser.id,
        UserId: remoteUser.id,
        incurredAt: expenseData.incurredAt || new Date(),
        PayoutMethodId: payoutMethod && payoutMethod.id,
        legacyPayoutMethod: models.Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
        amount: expenseData.amount || getTotalAmountFromItems(itemsData),
        data: { recipient },
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
  expense: typeof models.Expense,
  newExpenseData: ExpenseData,
  hasItemsChanges: boolean,
  hasPayoutChanges: boolean,
): boolean => {
  const updatedValues = { ...expense.dataValues, ...newExpenseData };
  const hasAmountChanges = typeof updatedValues.amount !== 'undefined' && updatedValues.amount !== expense.amount;
  const isPaidCreditCardCharge = expense.type === expenseType.CHARGE && expense.status === expenseStatus.PAID;

  if (isPaidCreditCardCharge && !hasAmountChanges) {
    return false;
  }
  return hasItemsChanges || hasAmountChanges || hasPayoutChanges;
};

/** Returns infos about the changes made to items */
export const getItemsChanges = async (
  expense: typeof models.Expense,
  expenseData: ExpenseData,
): Promise<
  [boolean, Record<string, unknown>[], [Record<string, unknown>[], ExpenseItem[], Record<string, unknown>[]]]
> => {
  if (expenseData.items) {
    const baseItems = await models.ExpenseItem.findAll({ where: { ExpenseId: expense.id } });
    const itemsDiff = models.ExpenseItem.diffDBEntries(baseItems, expenseData.items);
    const hasItemChanges = flatten(<unknown[]>itemsDiff).length > 0;
    return [hasItemChanges, expenseData.items, itemsDiff];
  } else {
    return [false, [], [[], [], []]];
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

export async function editExpense(
  req: express.Request,
  expenseData: ExpenseData,
  options = {},
): Promise<typeof models.Expense> {
  const remoteUser = options?.['overrideRemoteUser'] || req.remoteUser;
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to edit an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  const expense = await models.Expense.findByPk(expenseData.id, {
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'fromCollective' },
      { model: models.ExpenseAttachedFile, as: 'attachedFiles' },
      { model: models.PayoutMethod },
    ],
  });
  const [hasItemChanges, itemsData, itemsDiff] = await getItemsChanges(expense, expenseData);

  if (!expense) {
    throw new NotFound('Expense not found');
  }

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

  const isPaidCreditCardCharge =
    expense.type === expenseType.CHARGE && expense.status === expenseStatus.PAID && Boolean(expense.VirtualCardId);

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

  // Let's take the opportunity to update collective's location
  if (expenseData.payeeLocation?.address && !fromCollective.location.address) {
    await fromCollective.update({
      address: expenseData.payeeLocation.address,
      countryISO: expenseData.payeeLocation.country,
    });
  }

  const cleanExpenseData = pick(
    expenseData,
    isPaidCreditCardCharge ? EXPENSE_PAID_CHARGE_EDITABLE_FIELDS : EXPENSE_EDITABLE_FIELDS,
  );

  let payoutMethod = await expense.getPayoutMethod();

  // Validate bank account payout method
  if (payoutMethod?.type === PayoutMethodTypes.BANK_ACCOUNT) {
    const payoutMethodData = <BankAccountPayoutMethodData>payoutMethod.data;
    const accountHolderName = payoutMethodData?.accountHolderName;
    const legalName = <string>expenseData.fromCollective.legalName;
    if (accountHolderName && legalName && !isAccountHolderNameAndLegalNameMatch(accountHolderName, legalName)) {
      logger.warn('The legal name should match the bank account holder name (${accountHolderName} ≠ ${legalName})');
    }
  }
  const updatedExpense = await sequelize.transaction(async t => {
    // Update payout method if we get new data from one of the param for it
    if (
      !isPaidCreditCardCharge &&
      expenseData.payoutMethod !== undefined &&
      expenseData.payoutMethod?.id !== expense.PayoutMethodId
    ) {
      payoutMethod = await getPayoutMethodFromExpenseData(expenseData, remoteUser, fromCollective, t);
    }

    // Update items
    if (hasItemChanges) {
      checkExpenseItems({ ...expense.dataValues, ...cleanExpenseData }, itemsData);
      const [newItemsData, oldItems, itemsToUpdate] = itemsDiff;
      await Promise.all(<Promise<void>[]>[
        // Delete
        ...oldItems.map(item => {
          return item.destroy({ transaction: t });
        }),
        // Create
        ...newItemsData.map(itemData => {
          return models.ExpenseItem.createFromData(itemData, remoteUser, expense, t);
        }),
        // Update
        ...itemsToUpdate.map(itemData => {
          return models.ExpenseItem.updateFromData(itemData, t);
        }),
      ]);
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

      await createAttachedFiles(expense, newAttachedFiles, remoteUser, t);
      await Promise.all(removedAttachedFiles.map((file: ExpenseAttachedFile) => file.destroy()));
      await Promise.all(
        updatedAttachedFiles.map((file: Record<string, unknown>) =>
          models.ExpenseAttachedFile.update({ url: file.url }, { where: { id: file.id, ExpenseId: expense.id } }),
        ),
      );
    }

    const updatedExpenseProps = {
      ...cleanExpenseData,
      lastEditedById: remoteUser.id,
      incurredAt: expenseData.incurredAt || new Date(),
      status: shouldUpdateStatus ? 'PENDING' : expense.status,
      FromCollectiveId: fromCollective.id,
      PayoutMethodId: PayoutMethodId,
      legacyPayoutMethod: models.Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
      tags: cleanExpenseData.tags,
    };
    if (isPaidCreditCardCharge) {
      updatedExpenseProps['data'] = { ...expense.data, missingDetails: false };
    }
    return expense.update(updatedExpenseProps, { transaction: t });
  });

  if (isPaidCreditCardCharge) {
    if (cleanExpenseData.description) {
      await models.Transaction.update(
        { description: cleanExpenseData.description },
        { where: { ExpenseId: updatedExpense.id } },
      );
    }
  } else {
    await updatedExpense.createActivity(activities.COLLECTIVE_EXPENSE_UPDATED, remoteUser);
  }

  return updatedExpense;
}

export async function deleteExpense(req: express.Request, expenseId: number): Promise<typeof models.Expense> {
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

  const res = await expense.destroy();
  return res;
}

/** Helper that finishes the process of paying an expense */
async function markExpenseAsPaid(expense, remoteUser, isManualPayout = false): Promise<typeof models.Expense> {
  debug('update expense status to PAID', expense.id);
  await expense.setPaid(remoteUser.id);
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_PAID, remoteUser, { isManualPayout });
  return expense;
}

async function createTransactions(
  host,
  expense,
  fees: {
    paymentProcessorFeeInHostCurrency?: number;
    hostFeeInHostCurrency?: number;
    platformFeeInHostCurrency?: number;
  } = {},
  data = {},
) {
  debug('marking expense as paid and creating transactions in the ledger', expense.id);
  return await createTransactionFromPaidExpense(
    host,
    null,
    expense,
    null,
    expense.UserId,
    fees['paymentProcessorFeeInHostCurrency'],
    fees['hostFeeInHostCurrency'],
    fees['platformFeeInHostCurrency'],
    data,
  );
}

async function payExpenseWithPayPal(remoteUser, expense, host, paymentMethod, toPaypalEmail, fees = {}) {
  debug('payExpenseWithPayPal', expense.id);
  try {
    const paymentResponse = await paymentProviders.paypal.types['adaptive'].pay(
      expense.collective,
      expense,
      toPaypalEmail,
      paymentMethod.token,
    );
    await createTransactionFromPaidExpense(
      host,
      paymentMethod,
      expense,
      paymentResponse,
      expense.UserId,
      fees['paymentProcessorFeeInHostCurrency'],
      fees['hostFeeInHostCurrency'],
      fees['platformFeeInHostCurrency'],
    );
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
      throw new BadRequest(err.message);
    }
  }
}

export async function createTransferWiseTransactionsAndUpdateExpense({ host, expense, data, fees, remoteUser }) {
  await createTransactions(host, expense, fees, data);
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_PROCESSING, remoteUser);
  await expense.setProcessing(remoteUser.id);
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

export const getExpenseFeesInHostCurrency = async ({
  host,
  expense,
  fees,
  payoutMethod,
  forceManual,
}): Promise<{
  feesInHostCurrency: {
    paymentProcessorFeeInHostCurrency: number;
    hostFeeInHostCurrency: number;
    platformFeeInHostCurrency: number;
  };
  fees: {
    paymentProcessorFeeInCollectiveCurrency: number;
    hostFeeInCollectiveCurrency: number;
    platformFeeInCollectiveCurrency: number;
  };
}> => {
  const feesInHostCurrency = {
    paymentProcessorFeeInHostCurrency: undefined,
    hostFeeInHostCurrency: undefined,
    platformFeeInHostCurrency: undefined,
  };

  if (!expense.collective) {
    expense.collective = await models.Collective.findByPk(expense.CollectiveId);
  }

  const fxrate = await getFxRate(expense.collective.currency, host.currency);
  const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();

  if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT && !forceManual) {
    const [connectedAccount] = await host.getConnectedAccounts({
      where: { service: 'transferwise', deletedAt: null },
    });
    if (!connectedAccount) {
      throw new Error('Host is not connected to Transferwise');
    }
    const quote = await paymentProviders.transferwise.getTemporaryQuote(connectedAccount, payoutMethod, expense);
    const paymentOption = quote.paymentOptions.find(p => p.payIn === 'BALANCE' && p.payOut === quote.payOut);
    if (!paymentOption) {
      throw new BadRequest(`Could not find available payment option for this transaction.`, null, quote);
    }
    // Notice this is the FX rate between Host and Collective, that's why we use `fxrate`.
    fees.paymentProcessorFeeInCollectiveCurrency = floatAmountToCents(paymentOption.fee.total / fxrate);
  } else if (payoutMethodType === PayoutMethodTypes.PAYPAL && !forceManual) {
    fees.paymentProcessorFeeInCollectiveCurrency = await paymentProviders.paypal.types['adaptive'].fees({
      amount: expense.amount,
      currency: expense.collective.currency,
      host,
    });
  }

  feesInHostCurrency.paymentProcessorFeeInHostCurrency = Math.round(
    fxrate * (<number>fees.paymentProcessorFeeInCollectiveCurrency || 0),
  );
  feesInHostCurrency.hostFeeInHostCurrency = Math.round(fxrate * (<number>fees.hostFeeInCollectiveCurrency || 0));
  feesInHostCurrency.platformFeeInHostCurrency = Math.round(
    fxrate * (<number>fees.platformFeeInCollectiveCurrency || 0),
  );

  if (!fees.paymentProcessorFeeInCollectiveCurrency) {
    fees.paymentProcessorFeeInCollectiveCurrency = 0;
  }
  return { fees, feesInHostCurrency };
};

/**
 * Pay an expense based on the payout method defined in the Expense object
 * @PRE: fees { id, paymentProcessorFeeInCollectiveCurrency, hostFeeInCollectiveCurrency, platformFeeInCollectiveCurrency }
 * Note: some payout methods like PayPal will automatically define `paymentProcessorFeeInCollectiveCurrency`
 */
export async function payExpense(req: express.Request, args: Record<string, unknown>): Promise<typeof models.Expense> {
  const { remoteUser } = req;
  const expenseId = args.id;

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
      !(expense.status === statuses.ERROR && args.forceManual)
    ) {
      throw new Unauthorized(`Expense needs to be approved. Current status of the expense: ${expense.status}.`);
    }
    if (!(await canPayExpense(req, expense))) {
      throw new Unauthorized("You don't have permission to pay this expense");
    }
    const host = await expense.collective.getHostCollective();

    if (expense.legacyPayoutMethod === 'donation') {
      throw new Error('"In kind" donations are not supported anymore');
    }

    const balance = await expense.collective.getBalanceWithBlockedFunds();
    if (expense.amount > balance) {
      throw new Unauthorized(
        `Collective does not have enough funds to pay this expense. Current balance: ${formatCurrency(
          balance,
          expense.collective.currency,
        )}, Expense amount: ${formatCurrency(expense.amount, expense.collective.currency)}`,
      );
    }

    const payoutMethod = await expense.getPayoutMethod();
    const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();

    const { feesInHostCurrency, fees } = await getExpenseFeesInHostCurrency({
      host,
      expense,
      fees: omit(args, ['id', 'forceManual']),
      payoutMethod,
      forceManual: args.forceManual,
    });

    if (expense.amount + fees.paymentProcessorFeeInCollectiveCurrency > balance) {
      throw new Error(
        `Collective does not have enough funds to cover for the fees of this payment method. Current balance: ${formatCurrency(
          balance,
          expense.collective.currency,
        )}, Expense amount: ${formatCurrency(
          expense.amount,
          expense.collective.currency,
        )}, Estimated ${payoutMethodType} fees: ${formatCurrency(
          fees.paymentProcessorFeeInCollectiveCurrency,
          expense.collective.currency,
        )}`,
      );
    }

    // 2FA for payouts
    const isTwoFactorAuthenticationRequiredForPayoutMethod = [
      PayoutMethodTypes.PAYPAL,
      PayoutMethodTypes.BANK_ACCOUNT,
    ].includes(payoutMethodType);
    const hostHasPayoutTwoFactorAuthenticationEnabled = get(host, 'settings.payoutsTwoFactorAuth.enabled', false);
    const useTwoFactorAuthentication =
      isTwoFactorAuthenticationRequiredForPayoutMethod &&
      !args.forceManual &&
      hostHasPayoutTwoFactorAuthenticationEnabled;

    if (useTwoFactorAuthentication) {
      await handleTwoFactorAuthenticationPayoutLimit(req.remoteUser, args.twoFactorAuthenticatorCode, expense);
    }

    try {
      // Pay expense based on chosen payout method
      if (payoutMethodType === PayoutMethodTypes.PAYPAL) {
        const paypalEmail = payoutMethod.data.email;
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
          await createTransactions(host, expense, feesInHostCurrency);
        } else if (args.forceManual) {
          await createTransactions(host, expense, feesInHostCurrency);
        } else if (paypalPaymentMethod) {
          return payExpenseWithPayPal(remoteUser, expense, host, paypalPaymentMethod, paypalEmail, feesInHostCurrency);
        } else {
          throw new Error('No Paypal account linked, please reconnect Paypal or pay manually');
        }
      } else if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT) {
        if (args.forceManual) {
          feesInHostCurrency['paymentProcessorFeeInHostCurrency'] = 0;
          await createTransactions(host, expense, feesInHostCurrency);
        } else {
          const [connectedAccount] = await host.getConnectedAccounts({
            where: { service: 'transferwise', deletedAt: null },
          });
          if (!connectedAccount) {
            throw new Error('Host is not connected to Transferwise');
          }

          const data = await paymentProviders.transferwise.payExpense(connectedAccount, payoutMethod, expense);

          // Early return, Webhook will mark expense as Paid when the transaction completes.
          return createTransferWiseTransactionsAndUpdateExpense({
            host,
            expense,
            data,
            fees: feesInHostCurrency,
            remoteUser,
          });
        }
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
        await createTransactions(host, expense, feesInHostCurrency);
      } else if (expense.legacyPayoutMethod === 'manual' || expense.legacyPayoutMethod === 'other') {
        // note: we need to check for manual and other for legacy reasons
        await createTransactions(host, expense, feesInHostCurrency);
      }
    } catch (error) {
      if (useTwoFactorAuthentication) {
        await resetRollingPayoutLimitOnFailure(req.remoteUser, expense);
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
  processorFeeRefunded: boolean,
): Promise<typeof models.Expense> {
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
      where: { ExpenseId: expenseId, RefundTransactionId: null },
      include: [{ model: models.Expense }],
    });

    const paymentProcessorFeeInHostCurrency = processorFeeRefunded ? transaction.paymentProcessorFeeInHostCurrency : 0;
    await libPayments.createRefundTransaction(transaction, paymentProcessorFeeInHostCurrency, null, expense.User);

    return expense.update({ status: statuses.APPROVED, lastEditedById: remoteUser.id });
  });

  await updatedExpense.createActivity(activities.COLLECTIVE_EXPENSE_MARKED_AS_UNPAID, remoteUser);
  return updatedExpense;
}

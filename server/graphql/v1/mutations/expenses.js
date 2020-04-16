import debugLib from 'debug';
import { flatten, get, omit, pick, size } from 'lodash';

import { expenseStatus } from '../../../constants';
import activities from '../../../constants/activities';
import { types as collectiveTypes } from '../../../constants/collectives';
import statuses from '../../../constants/expense_status';
import expenseType from '../../../constants/expense_type';
import FEATURE from '../../../constants/feature';
import roles from '../../../constants/roles';
import { getFxRate } from '../../../lib/currency';
import errors from '../../../lib/errors';
import { floatAmountToCents } from '../../../lib/math';
import * as libPayments from '../../../lib/payments';
import { handleTransferwisePayoutsLimit } from '../../../lib/plans';
import { createFromPaidExpense as createTransactionFromPaidExpense } from '../../../lib/transactions';
import { canUseFeature } from '../../../lib/user-permissions';
import { formatCurrency } from '../../../lib/utils';
import models, { sequelize } from '../../../models';
import { PayoutMethodTypes } from '../../../models/PayoutMethod';
import paymentProviders from '../../../paymentProviders';
import { canDeleteExpense, canEditExpense, canUpdateExpenseStatus } from '../../common/expenses';
import { FeatureNotAllowedForUser, ValidationFailed } from '../../errors';

const debug = debugLib('expenses');

/**
 * Only admin of expense.collective.host can mark expenses unpaid
 */
function canMarkExpenseUnpaid(remoteUser, expense) {
  if (remoteUser.hasRole([roles.ADMIN], expense.collective.HostCollectiveId)) {
    return true;
  }
  return false;
}

export async function updateExpenseStatus(remoteUser, expenseId, status) {
  if (!remoteUser) {
    throw new errors.Unauthorized('You need to be logged in to update the status of an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  if (Object.keys(statuses).indexOf(status) === -1) {
    throw new errors.ValidationFailed('Invalid status, status must be one of ', Object.keys(statuses).join(', '));
  }

  const expense = await models.Expense.findByPk(expenseId, {
    include: [{ model: models.Collective, as: 'collective' }],
  });

  if (!expense) {
    throw new errors.Unauthorized('Expense not found');
  }
  if (expense.status === statuses.PROCESSING) {
    throw new errors.Unauthorized("You can't update the status of an expense being processed");
  }

  if (!canUpdateExpenseStatus(remoteUser, expense)) {
    throw new errors.Unauthorized("You don't have permission to approve this expense");
  } else if (expense.status === status) {
    return expense;
  }

  switch (status) {
    case statuses.APPROVED:
      if (expense.status === statuses.PAID) {
        throw new errors.Unauthorized("You can't approve an expense that is already paid");
      }
      break;
    case statuses.REJECTED:
      if (expense.status === statuses.PAID) {
        throw new errors.Unauthorized("You can't reject an expense that is already paid");
      }
      break;
    case statuses.PAID:
      if (expense.status !== statuses.APPROVED) {
        throw new errors.Unauthorized('The expense must be approved before you can set it to paid');
      }
      break;
  }

  const updatedExpense = await expense.update({ status, lastEditedById: remoteUser.id });

  // Create activity based on status change
  if (status === expenseStatus.APPROVED) {
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_APPROVED, remoteUser);
  } else if (status === expenseStatus.REJECTED) {
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_REJECTED, remoteUser);
  } else if (status === expenseStatus.PENDING) {
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_UNAPPROVED, remoteUser);
  }

  return updatedExpense;
}

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
  } else if (items.length > 100) {
    throw new ValidationFailed('Expenses cannot have more than 100 items');
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

const EXPENSE_EDITABLE_FIELDS = ['amount', 'description', 'category', 'type', 'tags', 'privateMessage', 'invoiceInfo'];

const getPaypalPaymentMethodFromExpenseData = async (expenseData, remoteUser, fromCollective, dbTransaction) => {
  if (expenseData.PayoutMethod) {
    if (expenseData.PayoutMethod.id) {
      const pm = await models.PayoutMethod.findByPk(expenseData.PayoutMethod.id);
      if (!pm || !remoteUser.isAdmin(pm.CollectiveId)) {
        throw new Error("This payout method does not exist or you don't have the permission to use it");
      } else if (pm.CollectiveId !== fromCollective.id) {
        throw new Error('This payout method cannot be used for this collective');
      }
      return pm;
    } else {
      return models.PayoutMethod.getOrCreateFromData(
        expenseData.PayoutMethod,
        remoteUser,
        fromCollective,
        dbTransaction,
      );
    }
  } else if (expenseData.payoutMethod === 'paypal') {
    // @deprecated - Should use `PayoutMethod` argument
    if (get(expenseData, 'user.paypalEmail')) {
      return models.PayoutMethod.getOrCreateFromData(
        { type: PayoutMethodTypes.PAYPAL, data: { email: get(expenseData, 'user.paypalEmail') } },
        remoteUser,
        fromCollective,
        dbTransaction,
      );
    } else {
      const paypalPms = await models.PayoutMethod.scope('paypal').findAll({
        where: { CollectiveId: fromCollective.id },
      });
      if (paypalPms.length === 0) {
        throw new ValidationFailed('No PayPal payout method configured for this account');
      } else if (paypalPms.length > 1) {
        // Make sure we're not linking to a wrong PayPal account
        throw new ValidationFailed(
          'Multiple PayPal payout method found for this account. Please select the one you want to use.',
        );
      } else {
        return paypalPms[0];
      }
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

export async function createExpense(remoteUser, expenseData) {
  if (!remoteUser) {
    throw new errors.Unauthorized('You need to be logged in to create an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  if (!get(expenseData, 'collective.id')) {
    throw new errors.Unauthorized('Missing expense.collective.id');
  }

  let itemsData = expenseData.items || expenseData.attachments;
  if (expenseData.attachment && itemsData) {
    throw new ValidationFailed('Fields "attachment" and "attachments"/"items" are exclusive, please use only one');
  } else if (expenseData.attachment) {
    // @deprecated Convert legacy attachment param to new format
    itemsData = [{ amount: expenseData.amount, url: expenseData.attachment }];
  }

  checkExpenseItems(expenseData, itemsData);

  if (size(expenseData.attachedFiles) > 15) {
    throw new ValidationFailed('The number of files that you can attach to an expense is limited to 15');
  }

  const collective = await models.Collective.findByPk(expenseData.collective.id);
  if (!collective) {
    throw new errors.ValidationFailed('Collective not found');
  } else if (![collectiveTypes.COLLECTIVE, collectiveTypes.EVENT].includes(collective.type)) {
    throw new errors.ValidationFailed('Expenses can only be submitted to collectives and events');
  }

  // Load the payee profile
  const fromCollective = expenseData.fromCollective || (await remoteUser.getCollective());
  if (!remoteUser.isAdmin(fromCollective.id)) {
    throw new ValidationFailed('You must be an admin of the account to submit an expense in its name');
  } else if (!fromCollective.canBeUsedAsPayoutProfile()) {
    throw new ValidationFailed('This account cannot be used for payouts');
  }

  const expense = await sequelize.transaction(async t => {
    // Get or create payout method
    const payoutMethod = await getPaypalPaymentMethodFromExpenseData(expenseData, remoteUser, fromCollective, t);

    // Create expense
    const createdExpense = await models.Expense.create(
      {
        ...pick(expenseData, EXPENSE_EDITABLE_FIELDS),
        currency: collective.currency,
        tags: expenseData.category ? [expenseData.category] : expenseData.tags,
        status: statuses.PENDING,
        CollectiveId: collective.id,
        FromCollectiveId: fromCollective.id,
        lastEditedById: remoteUser.id,
        UserId: remoteUser.id,
        incurredAt: expenseData.incurredAt || new Date(),
        PayoutMethodId: payoutMethod && payoutMethod.id,
        legacyPayoutMethod: models.Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
        amount: expenseData.amount || getTotalAmountFromItems(itemsData),
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

  collective.addUserWithRole(remoteUser, roles.CONTRIBUTOR).catch(e => {
    if (e.name === 'SequelizeUniqueConstraintError') {
      console.log('User ', remoteUser.id, 'is already a contributor');
    } else {
      console.error(e);
    }
  });

  expense.user = remoteUser;
  expense.collective = collective;
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_CREATED, remoteUser);
  return expense;
}

/** Returns true if the expense should by put back to PENDING after this update */
export const changesRequireStatusUpdate = (expense, newExpenseData, hasItemsChanges, hasPayoutChanges) => {
  const updatedValues = { ...expense.dataValues, ...newExpenseData };
  const hasAmountChanges = typeof updatedValues.amount !== 'undefined' && updatedValues.amount !== expense.amount;
  return hasItemsChanges || hasAmountChanges || hasPayoutChanges;
};

/** Returns infos about the changes made to items */
export const getItemsChanges = async (expense, expenseData) => {
  let itemsData = expenseData.items || expenseData.attachments;
  let itemsDiff = [[], [], []];
  let hasItemChanges = false;
  if (expenseData.attachment && itemsData) {
    throw new ValidationFailed('Fields "attachment" and "attachments"/"items" are exclusive, please use only one');
  } else if (expenseData.attachment) {
    // Convert legacy attachment param to new format
    itemsData = [{ amount: expenseData.amount || expense.amount, url: expenseData.attachment }];
  }

  if (itemsData) {
    const baseItems = await models.ExpenseItem.findAll({ where: { ExpenseId: expense.id } });
    itemsDiff = models.ExpenseItem.diffDBEntries(baseItems, itemsData);
    hasItemChanges = flatten(itemsDiff).length > 0;
  }

  return [hasItemChanges, itemsData, itemsDiff];
};

export async function editExpense(remoteUser, expenseData) {
  if (!remoteUser) {
    throw new errors.Unauthorized('You need to be logged in to edit an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  } else if (expenseData.payoutMethod && expenseData.PayoutMethod) {
    throw new Error('payoutMethod and PayoutMethod are exclusive, please use only one');
  }

  const expense = await models.Expense.findByPk(expenseData.id, {
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'fromCollective' },
      { model: models.ExpenseAttachedFile, as: 'attachedFiles' },
      { model: models.PayoutMethod },
    ],
  });

  if (!expense) {
    throw new errors.Unauthorized('Expense not found');
  } else if (!canEditExpense(remoteUser, expense)) {
    throw new errors.Unauthorized("You don't have permission to edit this expense");
  }

  if (size(expenseData.attachedFiles) > 15) {
    throw new ValidationFailed('The number of files that you can attach to an expense is limited to 15');
  }

  // Load the payee profile
  const fromCollective = expenseData.fromCollective || expense.fromCollective;
  if (expenseData.fromCollective && expenseData.fromCollective.id !== expense.fromCollective.id) {
    if (!remoteUser.isAdmin(fromCollective.id)) {
      throw new ValidationFailed('You must be an admin of the account to submit an expense in its name');
    } else if (!fromCollective.canBeUsedAsPayoutProfile()) {
      throw new ValidationFailed('This account cannot be used for payouts');
    }
  }

  const cleanExpenseData = pick(expenseData, EXPENSE_EDITABLE_FIELDS);
  let payoutMethod = await expense.getPayoutMethod();
  const updatedExpense = await sequelize.transaction(async t => {
    // Update payout method if we get new data from one of the param for it
    if (
      (expenseData.payoutMethod !== undefined && expenseData.payoutMethod !== expense.legacyPayoutMethod) ||
      (expenseData.PayoutMethod !== undefined && expenseData.PayoutMethod.id !== expense.PayoutMethodId)
    ) {
      payoutMethod = await getPaypalPaymentMethodFromExpenseData(expenseData, remoteUser, fromCollective, t);
    }

    // Update items
    const [hasItemChanges, itemsData, itemsDiff] = await getItemsChanges(expense, expenseData);
    if (hasItemChanges) {
      checkExpenseItems({ ...expense.dataValues, ...cleanExpenseData }, itemsData);
      const [newItemsData, oldItems, itemsToUpdate] = itemsDiff;
      await Promise.all([
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

    const existingTags = expense.tags || [];
    let tags = cleanExpenseData.tags;
    if (cleanExpenseData.category) {
      tags = [cleanExpenseData.category, ...existingTags];
    }

    // Update attached files
    if (expenseData.attachedFiles) {
      const [newAttachedFiles, removedAttachedFiles, updatedAttachedFiles] = models.ExpenseAttachedFile.diffDBEntries(
        expense.attachedFiles,
        expenseData.attachedFiles,
      );

      await createAttachedFiles(expense, newAttachedFiles, remoteUser, t);
      await Promise.all(removedAttachedFiles.map(file => file.destroy()));
      await Promise.all(
        updatedAttachedFiles.map(file =>
          models.ExpenseAttachedFile.update({ url: file.url }, { where: { id: file.id, ExpenseId: expense.id } }),
        ),
      );
    }

    return expense.update(
      {
        ...cleanExpenseData,
        lastEditedById: remoteUser.id,
        incurredAt: expenseData.incurredAt || new Date(),
        status: shouldUpdateStatus ? 'PENDING' : expense.status,
        FromCollectiveId: fromCollective.id,
        PayoutMethodId: PayoutMethodId,
        legacyPayoutMethod: models.Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
        tags,
      },
      { transaction: t },
    );
  });

  await updatedExpense.createActivity(activities.COLLECTIVE_EXPENSE_UPDATED, remoteUser);
  return updatedExpense;
}

export async function deleteExpense(remoteUser, expenseId) {
  if (!remoteUser) {
    throw new errors.Unauthorized('You need to be logged in to delete an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  const expense = await models.Expense.findByPk(expenseId, {
    include: [{ model: models.Collective, as: 'collective' }],
  });

  if (!expense) {
    throw new errors.NotFound('Expense not found');
  }

  if (!canDeleteExpense(remoteUser, expense)) {
    throw new errors.Unauthorized(
      "You don't have permission to delete this expense or it needs to be rejected before being deleted",
    );
  }

  const res = await expense.destroy();
  return res;
}

/** Helper that finishes the process of paying an expense */
async function markExpenseAsPaid(expense, remoteUser) {
  debug('update expense status to PAID', expense.id);
  await expense.setPaid(remoteUser.id);
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_PAID, remoteUser);
  return expense;
}

async function createTransactions(host, expense, fees = {}, data) {
  debug('marking expense as paid and creating transactions in the ledger', expense.id);
  return await createTransactionFromPaidExpense(
    host,
    null,
    expense,
    null,
    expense.UserId,
    fees.paymentProcessorFeeInHostCurrency,
    fees.hostFeeInHostCurrency,
    fees.platformFeeInHostCurrency,
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
      fees.paymentProcessorFeeInHostCurrency,
      fees.hostFeeInHostCurrency,
      fees.platformFeeInHostCurrency,
    );
    expense.setPaid(remoteUser.id);
    await paymentMethod.updateBalance();
  } catch (err) {
    debug('paypal> error', JSON.stringify(err, null, '  '));
    if (
      err.message.indexOf('The total amount of all payments exceeds the maximum total amount for all payments') !== -1
    ) {
      throw new errors.BadRequest(
        'Not enough funds in your existing Paypal preapproval. Please refill your PayPal payment balance.',
      );
    } else {
      throw new errors.BadRequest(err.message);
    }
  }
}

async function payExpenseWithTransferwise(host, payoutMethod, expense, fees, remoteUser) {
  debug('payExpenseWithTransferwise', expense.id);
  const [connectedAccount] = await host.getConnectedAccounts({
    where: { service: 'transferwise', deletedAt: null },
  });
  if (!connectedAccount) {
    throw new Error('Host is not connected to Transferwise');
  }

  await handleTransferwisePayoutsLimit(host);

  const data = await paymentProviders.transferwise.payExpense(connectedAccount, payoutMethod, expense);
  const transactions = await createTransactions(host, expense, fees, data);
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_PROCESSING, remoteUser);
  return transactions;
}

/**
 * Pay an expense based on the payout method defined in the Expense object
 * @PRE: fees { id, paymentProcessorFeeInCollectiveCurrency, hostFeeInCollectiveCurrency, platformFeeInCollectiveCurrency }
 * Note: some payout methods like PayPal will automatically define `paymentProcessorFeeInCollectiveCurrency`
 */
export async function payExpense(remoteUser, args) {
  const expenseId = args.id;
  const fees = omit(args, ['id', 'forceManual']);

  if (!remoteUser) {
    throw new errors.Unauthorized('You need to be logged in to pay an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }
  const expense = await models.Expense.findByPk(expenseId, {
    include: [{ model: models.Collective, as: 'collective' }],
  });
  if (!expense) {
    throw new errors.Unauthorized('Expense not found');
  }
  if (expense.status === statuses.PAID) {
    throw new errors.Unauthorized('Expense has already been paid');
  }
  if (expense.status === statuses.PROCESSING) {
    throw new errors.Unauthorized(
      'Expense is currently being processed, this means someone already started the payment process',
    );
  }
  if (expense.status !== statuses.APPROVED) {
    throw new errors.Unauthorized(`Expense needs to be approved. Current status of the expense: ${expense.status}.`);
  }
  if (!remoteUser.isAdmin(expense.collective.HostCollectiveId)) {
    throw new errors.Unauthorized("You don't have permission to pay this expense");
  }
  const host = await expense.collective.getHostCollective();

  if (expense.legacyPayoutMethod === 'donation') {
    throw new Error('"In kind" donations are not supported anymore');
  }

  const balance = await expense.collective.getBalance();
  if (expense.amount > balance) {
    throw new errors.Unauthorized(
      `You don't have enough funds to pay this expense. Current balance: ${formatCurrency(
        balance,
        expense.collective.currency,
      )}, Expense amount: ${formatCurrency(expense.amount, expense.collective.currency)}`,
    );
  }

  const feesInHostCurrency = {};
  const fxrate = await getFxRate(expense.collective.currency, host.currency);
  const payoutMethod = await expense.getPayoutMethod();
  const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();

  if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT) {
    const [connectedAccount] = await host.getConnectedAccounts({
      where: { service: 'transferwise', deletedAt: null },
    });
    if (!connectedAccount) {
      throw new Error('Host is not connected to Transferwise');
    }
    const quote = await paymentProviders.transferwise.getTemporaryQuote(connectedAccount, payoutMethod, expense);
    // Notice this is the FX rate between Host and Collective, that's why we use `fxrate`.
    fees.paymentProcessorFeeInCollectiveCurrency = floatAmountToCents(quote.fee / fxrate);
  } else if (payoutMethodType === PayoutMethodTypes.PAYPAL && !args.forceManual) {
    fees.paymentProcessorFeeInCollectiveCurrency = await paymentProviders.paypal.types['adaptive'].fees({
      amount: expense.amount,
      currency: expense.collective.currency,
      host,
    });
  }

  feesInHostCurrency.paymentProcessorFeeInHostCurrency = Math.round(
    fxrate * (fees.paymentProcessorFeeInCollectiveCurrency || 0),
  );
  feesInHostCurrency.hostFeeInHostCurrency = Math.round(fxrate * (fees.hostFeeInCollectiveCurrency || 0));
  feesInHostCurrency.platformFeeInHostCurrency = Math.round(fxrate * (fees.platformFeeInCollectiveCurrency || 0));

  if (!fees.paymentProcessorFeeInCollectiveCurrency) {
    fees.paymentProcessorFeeInCollectiveCurrency = 0;
  }

  if (expense.amount + fees.paymentProcessorFeeInCollectiveCurrency > balance) {
    throw new Error(
      `You don't have enough funds to cover for the fees of this payment method. Current balance: ${formatCurrency(
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

  // Pay expense based on chosen payout method
  if (payoutMethodType === PayoutMethodTypes.PAYPAL) {
    const paypalEmail = payoutMethod.data.email;
    let paypalPaymentMethod = null;
    try {
      paypalPaymentMethod = await host.getPaymentMethod({ service: 'paypal' });
    } catch {
      // ignore missing paypal payment method
    }
    // If the expense has been filed with the same paypal email than the host paypal
    // then we simply mark the expense as paid
    if (paypalPaymentMethod && paypalEmail === paypalPaymentMethod.name) {
      feesInHostCurrency.paymentProcessorFeeInHostCurrency = 0;
      await createTransactions(host, expense, feesInHostCurrency);
    } else if (args.forceManual) {
      await createTransactions(host, expense, feesInHostCurrency);
    } else if (paypalPaymentMethod) {
      await payExpenseWithPayPal(remoteUser, expense, host, paypalPaymentMethod, paypalEmail, feesInHostCurrency);
    } else {
      throw new Error('No Paypal account linked, please reconnect Paypal or pay manually');
    }
  } else if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT) {
    await payExpenseWithTransferwise(host, payoutMethod, expense, feesInHostCurrency, remoteUser);
    await expense.setProcessing(remoteUser.id);
    // Early return, we'll only mark as Paid when the transaction completes.
    return;
  } else if (expense.legacyPayoutMethod === 'manual' || expense.legacyPayoutMethod === 'other') {
    // note: we need to check for manual and other for legacy reasons
    await createTransactions(host, expense, feesInHostCurrency);
  }

  return markExpenseAsPaid(expense, remoteUser);
}

export async function markExpenseAsUnpaid(remoteUser, ExpenseId, processorFeeRefunded) {
  if (!remoteUser) {
    throw new errors.Unauthorized('You need to be logged in to unpay an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  const expense = await models.Expense.findByPk(ExpenseId, {
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.User, as: 'User' },
      { model: models.PayoutMethod },
    ],
  });

  if (!expense) {
    throw new errors.NotFound('No expense found');
  }

  if (!canMarkExpenseUnpaid(remoteUser, expense)) {
    throw new errors.Unauthorized("You don't have permission to mark this expense as unpaid");
  }

  if (expense.status !== statuses.PAID) {
    throw new errors.Unauthorized('Expense has not been paid yet');
  }

  if (expense.legacyPayoutMethod !== 'other') {
    throw new errors.Unauthorized('Only expenses with "other" payout method can be marked as unpaid');
  }

  const transaction = await models.Transaction.findOne({
    where: { ExpenseId },
    include: [{ model: models.Expense }],
  });

  const paymentProcessorFeeInHostCurrency = processorFeeRefunded ? transaction.paymentProcessorFeeInHostCurrency : 0;
  const refundedTransaction = await libPayments.createRefundTransaction(
    transaction,
    paymentProcessorFeeInHostCurrency,
    null,
    expense.User,
  );
  await libPayments.associateTransactionRefundId(transaction, refundedTransaction);

  const updatedExpense = await expense.update({ status: statuses.APPROVED, lastEditedById: remoteUser.id });
  await updatedExpense.createActivity(activities.COLLECTIVE_EXPENSE_MARKED_AS_UNPAID, remoteUser);
  return updatedExpense;
}

import express from 'express';
import { GraphQLNonNull, GraphQLString } from 'graphql';
import { isEqual, isUndefined, omit, pick } from 'lodash';

import { activities } from '../../../constants';
import ExpenseStatuses from '../../../constants/expense-status';
import {
  handleKycPayoutMethodEdited,
  handleKycPayoutMethodReplaced,
} from '../../../lib/kyc/expenses/kyc-expenses-check';
import { reportErrorToSentry } from '../../../lib/sentry';
import sequelize from '../../../lib/sequelize';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models, { Op, PayoutMethod } from '../../../models';
import PayoutMethodModel, { PayoutMethodTypes, PaypalPayoutMethodData } from '../../../models/PayoutMethod';
import { checkRemoteUserCanUseExpenses } from '../../common/scope-check';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLPayoutMethodInput } from '../input/PayoutMethodInput';
import { fetchPayoutMethodWithReference } from '../input/PayoutMethodReferenceInput';
import GraphQLPayoutMethod from '../object/PayoutMethod';

/**
 * Fan-out a `COLLECTIVE_EXPENSE_UPDATED` activity to all expenses using the payout method,
 * so payout-method edits are surfaced in expense threads.
 * Best-effort: never throws. See https://github.com/opencollective/opencollective/issues/8702
 */
type PayoutMethodSnapshot = {
  id: number;
  type: PayoutMethodTypes | string;
  name?: string;
  isSaved?: boolean;
  currency?: string | null;
  filteredData: Record<string, unknown>;
};

const createPayoutMethodExpenseActivities = async (
  oldSnapshot: PayoutMethodSnapshot,
  newSnapshot: PayoutMethodSnapshot,
  user: { id: number },
): Promise<void> => {
  try {
    const payoutMethodIds = [...new Set([oldSnapshot.id, newSnapshot.id].filter(Boolean))];
    if (!payoutMethodIds.length) {
      return;
    }

    const oldFiltered = {
      id: oldSnapshot.id,
      type: oldSnapshot.type,
      name: oldSnapshot.name,
      isSaved: oldSnapshot.isSaved,
      currency: oldSnapshot.currency,
      data: oldSnapshot.filteredData,
    };
    const newFiltered = {
      id: newSnapshot.id,
      type: newSnapshot.type,
      name: newSnapshot.name,
      isSaved: newSnapshot.isSaved,
      currency: newSnapshot.currency,
      data: newSnapshot.filteredData,
    };

    // Paginate through all linked expenses (no overall cap), oldest first for stable paging.
    const BATCH_SIZE = 100;
    let lastId = 0;
    for (;;) {
      const expenses = await models.Expense.findAll({
        where: { id: { [Op.gt]: lastId }, PayoutMethodId: payoutMethodIds },
        order: [['id', 'ASC']],
        limit: BATCH_SIZE,
      });

      if (!expenses.length) {
        return;
      }
      lastId = expenses[expenses.length - 1].id;

      for (const expense of expenses) {
        try {
          await expense.createActivity(activities.COLLECTIVE_EXPENSE_UPDATED, user, {
            isSystem: true,
            notify: false,
            previousData: { payoutMethod: oldFiltered },
            newData: { payoutMethod: newFiltered },
          });
        } catch (e) {
          reportErrorToSentry(e, { extra: { expenseId: expense.id, payoutMethodId: oldSnapshot.id } });
        }
      }

      if (expenses.length < BATCH_SIZE) {
        return;
      }
    }
  } catch (e) {
    reportErrorToSentry(e, { extra: { payoutMethodId: oldSnapshot.id } });
  }
};

const toPayoutMethodSnapshot = (payoutMethod: PayoutMethodModel): PayoutMethodSnapshot => ({
  id: payoutMethod.id,
  type: payoutMethod.type,
  name: payoutMethod.name,
  isSaved: payoutMethod.isSaved,
  currency: payoutMethod.currency,
  filteredData: payoutMethod.getFilteredData() as Record<string, unknown>,
});

const payoutMethodMutations = {
  createPayoutMethod: {
    type: GraphQLPayoutMethod,
    description: 'Create a new Payout Method to get paid through the platform. Scope: "expenses".',
    args: {
      payoutMethod: {
        type: new GraphQLNonNull(GraphQLPayoutMethodInput),
        description: 'Payout Method data',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account where the payout method will be associated',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<PayoutMethodModel> {
      checkRemoteUserCanUseExpenses(req);

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized("You don't have permission to edit this collective");
      }

      // Enforce 2FA
      await twoFactorAuthLib.enforceForAccount(req, collective);

      if (args.payoutMethod.type === PayoutMethodTypes.OTHER && !args.payoutMethod.data) {
        throw new ValidationFailed(
          'Custom payout methods must have a `data` object with a `content` and a `currency` field',
        );
      } else if (
        args.payoutMethod.currency &&
        args.payoutMethod.data?.currency &&
        args.payoutMethod.currency !== args.payoutMethod.data?.currency
      ) {
        throw new ValidationFailed('Currency mismatch between data and currency');
      }

      return models.PayoutMethod.createFromUserData(
        {
          name: args.payoutMethod.name,
          type: args.payoutMethod.type,
          data: args.payoutMethod.data, // createFromUserData calls filterUserSubmittedData
          isSaved: args.payoutMethod.isSaved,
          currency: args.payoutMethod.currency || args.payoutMethod.data?.currency,
        },
        req.remoteUser,
        collective,
      );
    },
  },
  removePayoutMethod: {
    description: 'Remove the given payout method. Scope: "expenses".',
    type: new GraphQLNonNull(GraphQLPayoutMethod),
    args: {
      payoutMethodId: {
        type: new GraphQLNonNull(GraphQLString),
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<PayoutMethodModel> {
      checkRemoteUserCanUseExpenses(req);

      const payoutMethod = await fetchPayoutMethodWithReference({ id: args.payoutMethodId });

      if (!payoutMethod) {
        throw new NotFound('This payout method does not exist');
      }

      const collective = await req.loaders.Collective.byId.load(payoutMethod.CollectiveId);
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Forbidden();
      }

      // Enforce 2FA
      await twoFactorAuthLib.enforceForAccount(req, collective);

      return sequelize.transaction(async transaction => {
        if (await payoutMethod.canBeDeleted({ transaction })) {
          await payoutMethod.destroy({ transaction });
        } else if (payoutMethod.canBeArchived()) {
          await payoutMethod.update({ isSaved: false }, { transaction });
        } else {
          throw new Forbidden();
        }

        const paypalData = payoutMethod.data as PaypalPayoutMethodData;
        const linkedConnectedAccountId =
          payoutMethod.type === PayoutMethodTypes.PAYPAL && paypalData?.isPayPalOAuth
            ? paypalData?.connectedAccountId
            : null;
        if (linkedConnectedAccountId) {
          const connectedAccount = await models.ConnectedAccount.findByPk(linkedConnectedAccountId, { transaction });
          if (connectedAccount) {
            // As of 2026-04-15, PayPal does not offer an API endpoint to revoke user OAuth tokens
            // (https://developer.paypal.com/docs/api/identity/v1/), so we only destroy the record locally.
            await connectedAccount.update({ token: null, refreshToken: null }, { transaction });
            await connectedAccount.destroy({ transaction });
          }
        }

        return payoutMethod;
      });
    },
  },
  editPayoutMethod: {
    type: new GraphQLNonNull(GraphQLPayoutMethod),
    args: {
      payoutMethod: {
        type: new GraphQLNonNull(GraphQLPayoutMethodInput),
        description: 'Payout Method reference',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<PayoutMethodModel> {
      checkRemoteUserCanUseExpenses(req);

      const payoutMethod = await fetchPayoutMethodWithReference(args.payoutMethod);

      const collective = await req.loaders.Collective.byId.load(payoutMethod.CollectiveId);
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Forbidden();
      }

      // Enforce 2FA
      await twoFactorAuthLib.enforceForAccount(req, collective);

      // Validate currency arguments
      if (
        args.payoutMethod.currency &&
        args.payoutMethod.data?.currency &&
        args.payoutMethod.currency !== args.payoutMethod.data?.currency
      ) {
        throw new ValidationFailed('Currency mismatch between data and currency');
      }

      if (!payoutMethod.isSaved && args.payoutMethod.isSaved === true) {
        throw new Forbidden('Archived payout methods cannot be restored.');
      } else if (
        payoutMethod.type === PayoutMethodTypes.PAYPAL &&
        (payoutMethod.data as PaypalPayoutMethodData)?.isPayPalOAuth
      ) {
        // Verified PayPal accounts have some restrictions on editing: only the name, isSaved and currency can be edited
        if (
          !isUndefined(args.payoutMethod.data) &&
          !isEqual(
            omit(models.PayoutMethod.getFilteredData(payoutMethod.type, args.payoutMethod.data), ['currency']),
            omit(payoutMethod.getFilteredData(), ['currency']),
          )
        ) {
          throw new Forbidden(
            'Verified PayPal accounts can only be edited to change the name, saved status and currency',
          );
        }
      }

      const isExistingPayPalOAuthMethod = Boolean(
        payoutMethod.type === PayoutMethodTypes.PAYPAL && (payoutMethod.data as PaypalPayoutMethodData)?.isPayPalOAuth,
      );

      if (await payoutMethod.canBeEdited()) {
        const oldPayoutMethodDataValues = payoutMethod.dataValues;
        const oldSnapshot = toPayoutMethodSnapshot(payoutMethod);
        const updatedPayoutMethod = await payoutMethod.update({
          ...pick(args.payoutMethod, ['name', 'isSaved']),
          currency: args.payoutMethod.currency || args.payoutMethod.data?.currency,
          CollectiveId: collective.id,
          CreatedByUserId: req.remoteUser.id,
          data: {
            ...payoutMethod.data,
            ...PayoutMethod.filterUserSubmittedData(payoutMethod.type, args.payoutMethod.data, {
              isExistingPayPalOAuthMethod,
            }),
          }, // Always preserve existing data, since user only see a filtered version (getFilteredData)
        });
        try {
          await handleKycPayoutMethodEdited(oldPayoutMethodDataValues, updatedPayoutMethod);
        } catch (e) {
          reportErrorToSentry(e, { req, user: req.remoteUser, extra: { payoutMethodId: updatedPayoutMethod.id } });
        }
        // Surface the edit in related expense threads (best-effort, no email).
        // Skip when nothing actually changed (e.g. saving without edits).
        const newSnapshot = toPayoutMethodSnapshot(updatedPayoutMethod);
        if (!isEqual(oldSnapshot, newSnapshot)) {
          await createPayoutMethodExpenseActivities(oldSnapshot, newSnapshot, req.remoteUser);
        }
        return updatedPayoutMethod;
      } else if (payoutMethod.canBeArchived()) {
        // Capture the pre-archive state for the expense thread fan-out
        const oldSnapshot = toPayoutMethodSnapshot(payoutMethod);
        // Archive the current payout method and create a new one
        await payoutMethod.update({ isSaved: false });
        const newPayoutMethod = await models.PayoutMethod.create({
          ...pick(payoutMethod, ['name', 'type']),
          ...pick(args.payoutMethod, ['name', 'isSaved']),
          currency: args.payoutMethod.currency || args.payoutMethod.data?.currency,
          CollectiveId: collective.id,
          CreatedByUserId: req.remoteUser.id,
          data: {
            ...payoutMethod.data,
            ...PayoutMethod.filterUserSubmittedData(payoutMethod.type, args.payoutMethod.data, {
              isExistingPayPalOAuthMethod,
            }),
          }, // Always preserve existing data, since user only see a filtered version (getFilteredData)
        });

        // Update Pending expenses to use the new payout method
        await models.Expense.update(
          { PayoutMethodId: newPayoutMethod.id },
          { where: { PayoutMethodId: payoutMethod.id, status: [ExpenseStatuses.PENDING, ExpenseStatuses.DRAFT] } },
        );
        try {
          await handleKycPayoutMethodReplaced(payoutMethod, newPayoutMethod);
        } catch (e) {
          reportErrorToSentry(e, {
            req,
            user: req.remoteUser,
            extra: { oldPayoutMethodId: payoutMethod.id, newPayoutMethodId: newPayoutMethod.id },
          });
        }
        // Surface the replacement in related expense threads (best-effort, no email).
        // Covers both historical expenses (still on the old id) and pending expenses (now on the new id).
        // Skip when nothing actually changed.
        const newSnapshot = toPayoutMethodSnapshot(newPayoutMethod);
        if (!isEqual(oldSnapshot, newSnapshot)) {
          await createPayoutMethodExpenseActivities(oldSnapshot, newSnapshot, req.remoteUser);
        }
        return newPayoutMethod;
      } else {
        throw new Forbidden();
      }
    },
  },
};

export default payoutMethodMutations;

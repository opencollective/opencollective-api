import express from 'express';
import { GraphQLNonNull, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import ExpenseStatuses from '../../../constants/expense-status';
import logger from '../../../lib/logger';
import { reportErrorToSentry } from '../../../lib/sentry';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import PayoutMethodModel, { PayoutMethodTypes } from '../../../models/PayoutMethod';
import { checkRemoteUserCanUseExpenses } from '../../common/scope-check';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLPayoutMethodInput } from '../input/PayoutMethodInput';
import { fetchPayoutMethodWithReference, GraphQLPayoutMethodReferenceInput } from '../input/PayoutMethodReferenceInput';
import GraphQLPayoutMethod from '../object/PayoutMethod';

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

      if (args.payoutMethod.data?.isManualBankTransfer) {
        try {
          await collective.setCurrency(args.payoutMethod.data.currency);
        } catch (error) {
          logger.error(`Unable to set currency for '${collective.slug}': ${error.message}`);
          reportErrorToSentry(error);
        }

        const existingBankAccount = await models.PayoutMethod.findOne({
          where: {
            data: { isManualBankTransfer: true },
            CollectiveId: collective.id,
            isSaved: true,
          },
        });
        if (existingBankAccount) {
          return await existingBankAccount.update(pick(args.payoutMethod, ['name', 'data']));
        }
      } else if (args.payoutMethod.type === PayoutMethodTypes.OTHER && !args.payoutMethod.data) {
        throw new ValidationFailed(
          'Custom payout methods must have a `data` object with a `content` and a `currency` field',
        );
      }

      return await models.PayoutMethod.create({
        ...pick(args.payoutMethod, ['name', 'data', 'type']),
        CollectiveId: collective.id,
        CreatedByUserId: req.remoteUser.id,
      });
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

      const pmId = idDecode(args.payoutMethodId, IDENTIFIER_TYPES.PAYOUT_METHOD);
      const payoutMethod: PayoutMethodModel = await req.loaders.PayoutMethod.byId.load(pmId);

      if (!payoutMethod) {
        throw new NotFound('This payout method does not exist');
      }

      const collective = await req.loaders.Collective.byId.load(payoutMethod.CollectiveId);
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Forbidden();
      }

      if (await payoutMethod.canBeDeleted()) {
        await payoutMethod.destroy();
        return payoutMethod;
      } else if (await payoutMethod.canBeArchived()) {
        return payoutMethod.update({
          isSaved: false,
          data: {
            ...payoutMethod.data,
            ...(payoutMethod.data['isManualBankTransfer'] ? { isManualBankTransfer: false } : {}),
          },
        });
      } else {
        throw new Forbidden();
      }
    },
  },
  restorePayoutMethod: {
    description: 'Restore the given payout method. Scope: "expenses".',
    type: new GraphQLNonNull(GraphQLPayoutMethod),
    args: {
      payoutMethod: {
        type: new GraphQLNonNull(GraphQLPayoutMethodReferenceInput),
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

      return payoutMethod.update({ isSaved: true });
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

      if (await payoutMethod.canBeEdited()) {
        return await payoutMethod.update({
          ...pick(args.payoutMethod, ['name', 'data', 'isSaved']),
          CollectiveId: collective.id,
          CreatedByUserId: req.remoteUser.id,
        });
      } else if (await payoutMethod.canBeArchived()) {
        // Archive the current payout method and create a new one
        await payoutMethod.update({ isSaved: false });
        const newPayoutMethod = await models.PayoutMethod.create({
          ...pick(payoutMethod, ['name', 'data', 'type']),
          ...pick(args.payoutMethod, ['name', 'data', 'type', 'isSaved']),
          CollectiveId: collective.id,
          CreatedByUserId: req.remoteUser.id,
        });
        // Update Pending expenses to use the new payout method
        await models.Expense.update(
          { PayoutMethodId: newPayoutMethod.id },
          { where: { PayoutMethodId: payoutMethod.id, status: [ExpenseStatuses.PENDING, ExpenseStatuses.DRAFT] } },
        );
        return newPayoutMethod;
      } else {
        throw new Forbidden();
      }
    },
  },
};

export default payoutMethodMutations;

import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import models from '../../../models';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { NotFound, Unauthorized } from '../../errors';
import { getIntervalFromTierFrequency } from '../enum/TierFrequency';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput } from '../input/AmountInput';
import { TierCreateInput } from '../input/TierCreateInput';
import { fetchTierWithReference, TierReferenceInput } from '../input/TierReferenceInput';
import { TierUpdateInput } from '../input/TierUpdateInput';
import { Tier } from '../object/Tier';

const tierMutations = {
  editTier: {
    type: new GraphQLNonNull(Tier),
    description: 'Edit a tier.',
    args: {
      tier: {
        type: new GraphQLNonNull(TierUpdateInput),
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);

      const tierId = idDecode(args.tier.id, IDENTIFIER_TYPES.TIER);
      const tier = await models.Tier.findByPk(tierId);
      if (!tier) {
        throw new NotFound('Tier Not Found');
      }

      const collective = await req.loaders.Collective.byId.load(tier.CollectiveId);
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized();
      }

      if (args.tier.amountType === 'FIXED') {
        args.tier.presets = null;
        args.tier.minimumAmount = null;
      }

      const tierUpdateData = {
        ...args.tier,
        id: tierId,
        amount: getValueInCentsFromAmountInput(args.tier.amount),
        minimumAmount: args.tier.minimumAmount ? getValueInCentsFromAmountInput(args.tier.minimumAmount) : null,
        goal: args.tier.goal ? getValueInCentsFromAmountInput(args.tier.goal) : null,
        interval: getIntervalFromTierFrequency(args.tier.frequency),
      };
      let data;
      if (args.tier.singleTicket !== undefined) {
        const tier = await models.Tier.findOne({ where: { id: tierId } });
        data = { ...tier.data, singleTicket: args.tier.singleTicket };
        tierUpdateData.data = data;
      }

      return await tier.update(tierUpdateData);
    },
  },
  createTier: {
    type: new GraphQLNonNull(Tier),
    description: 'Create a tier.',
    args: {
      tier: {
        type: new GraphQLNonNull(TierCreateInput),
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account to create tier in',
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Unauthorized();
      }

      if (args.tier.amountType === 'FIXED') {
        args.tier.presets = null;
        args.tier.minimumAmount = null;
      }
      const tierData = {
        ...args.tier,
        CollectiveId: account.id,
        currency: account.currency,
        amount: getValueInCentsFromAmountInput(args.tier.amount),
        minimumAmount: args.tier.minimumAmount ? getValueInCentsFromAmountInput(args.tier.minimumAmount) : null,
        goal: args.tier.goal ? getValueInCentsFromAmountInput(args.tier.goal) : null,
        interval: getIntervalFromTierFrequency(args.tier.interval),
      };
      if (args.tier.singleTicket !== undefined) {
        tierData.data = { singleTicket: args.tier.singleTicket };
      }

      return models.Tier.create(tierData);
    },
  },
  deleteTier: {
    type: new GraphQLNonNull(Tier),
    description: 'Delete a tier.',
    args: {
      tier: {
        type: new GraphQLNonNull(TierReferenceInput),
      },
      stopRecurringContributions: {
        type: new GraphQLNonNull(GraphQLBoolean),
        defaultValue: false,
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);

      const tier = await fetchTierWithReference(args.tier, { throwIfMissing: true });
      const collective = await req.loaders.Collective.byId.load(tier.CollectiveId);
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized();
      }

      if (args.stopRecurringContributions) {
        await models.Order.cancelActiveOrdersByTierId(tier.id);
      }

      await tier.destroy();
      return tier;
    },
  },
};

export default tierMutations;

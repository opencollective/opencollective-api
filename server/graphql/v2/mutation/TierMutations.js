import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import { purgeCacheForCollective } from '../../../lib/cache';
import { purgeCacheForPage } from '../../../lib/cloudflare';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
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

      // Check 2FA
      await twoFactorAuthLib.enforceForAccountAdmins(req, collective, { onlyAskOnLogin: true });

      if (args.tier.amountType === 'FIXED') {
        args.tier.presets = null;
        args.tier.minimumAmount = null;
      }

      const updatedTier = await tier.update({
        ...args.tier,
        id: tierId,
        amount: getValueInCentsFromAmountInput(args.tier.amount),
        minimumAmount: args.tier.minimumAmount ? getValueInCentsFromAmountInput(args.tier.minimumAmount) : null,
        goal: args.tier.goal ? getValueInCentsFromAmountInput(args.tier.goal) : null,
        interval: getIntervalFromTierFrequency(args.tier.frequency),
      });

      // Purge cache
      purgeCacheForCollective(collective.slug);
      purgeCacheForPage(`/${collective.slug}/contribute/${tier.slug}-${tier.id}`);

      return updatedTier;
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

      // Check 2FA
      await twoFactorAuthLib.enforceForAccountAdmins(req, account, { onlyAskOnLogin: true });

      if (args.tier.amountType === 'FIXED') {
        args.tier.presets = null;
        args.tier.minimumAmount = null;
      }

      const tier = await models.Tier.create({
        ...args.tier,
        CollectiveId: account.id,
        currency: account.currency,
        amount: getValueInCentsFromAmountInput(args.tier.amount),
        minimumAmount: args.tier.minimumAmount ? getValueInCentsFromAmountInput(args.tier.minimumAmount) : null,
        goal: args.tier.goal ? getValueInCentsFromAmountInput(args.tier.goal) : null,
        interval: getIntervalFromTierFrequency(args.tier.frequency),
      });

      // Purge cache
      purgeCacheForCollective(account.slug);

      return tier;
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

      // Check 2FA
      await twoFactorAuthLib.enforceForAccountAdmins(req, collective);

      if (args.stopRecurringContributions) {
        await models.Order.cancelActiveOrdersByTierId(tier.id);
      }

      await tier.destroy();

      // Purge cache
      purgeCacheForCollective(collective.slug);
      purgeCacheForPage(`/${collective.slug}/contribute/${tier.slug}-${tier.id}`);

      return tier;
    },
  },
};

export default tierMutations;

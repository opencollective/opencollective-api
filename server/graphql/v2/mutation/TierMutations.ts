import { GraphQLBoolean, GraphQLNonNull } from 'graphql';
import { isNil, isUndefined, omitBy, pick, uniq } from 'lodash';

import { purgeCacheForCollective } from '../../../lib/cache';
import { purgeCacheForPage } from '../../../lib/cloudflare';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models, { Tier as TierModel } from '../../../models';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { NotFound, Unauthorized } from '../../errors';
import { getIntervalFromTierFrequency } from '../enum/TierFrequency';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput } from '../input/AmountInput';
import { TierCreateInput, TierCreateInputFields } from '../input/TierCreateInput';
import { fetchTierWithReference, TierReferenceInput } from '../input/TierReferenceInput';
import { TierUpdateInput, TierUpdateInputFields } from '../input/TierUpdateInput';
import { Tier } from '../object/Tier';

// Makes sure we default to `undefined` if the amount is not set to not override existing values with `null`
const getAmountWithDefault = (amountInput, existingAmount = undefined) =>
  (amountInput ? getValueInCentsFromAmountInput(amountInput) : existingAmount) ?? undefined;

const transformTierInputToAttributes = (
  tierInput: TierCreateInputFields | TierUpdateInputFields,
  existingTier: TierModel = null,
) => {
  // Copy all fields that don't need to be transformed
  const attributes = pick(tierInput, [
    'name',
    'description',
    'button',
    'type',
    'amountType',
    'presets',
    'maxQuantity',
    'useStandalonePage',
  ]);

  // Transform fields that need to be transformed
  attributes['amount'] = getAmountWithDefault(tierInput.amount, existingTier?.amount);
  attributes['minimumAmount'] = getAmountWithDefault(tierInput.minimumAmount, existingTier?.minimumAmount);
  attributes['goal'] = getAmountWithDefault(tierInput.goal, existingTier?.goal);
  attributes['interval'] = getIntervalFromTierFrequency(tierInput.frequency);
  attributes['data'] = existingTier?.data || null;

  // Set data fields
  if (tierInput.singleTicket !== undefined) {
    attributes['data'] = { ...attributes['data'], singleTicket: tierInput.singleTicket };
  }

  if (tierInput.invoiceTemplate !== undefined) {
    attributes['data'] = { ...attributes['data'], invoiceTemplate: tierInput.invoiceTemplate };
  }

  // Adjust some fields based on other fields
  if (attributes.amountType === 'FIXED') {
    attributes['presets'] = null;
    attributes['minimumAmount'] = null;
  } else if (attributes.presets && !isNil(attributes['amount'])) {
    attributes['presets'] = uniq([attributes['amount'], ...tierInput.presets]); // Make sure default amount is included in presets
  }

  return omitBy(attributes, isUndefined);
};

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
      const tier = await TierModel.findByPk(tierId);
      if (!tier) {
        throw new NotFound('Tier Not Found');
      }

      const collective = await req.loaders.Collective.byId.load(tier.CollectiveId);
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized();
      }

      // Check 2FA
      await twoFactorAuthLib.enforceForAccountAdmins(req, collective, { onlyAskOnLogin: true });

      // Update tier
      const updatedTier = await tier.update(transformTierInputToAttributes(args.tier));

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

      // Create tier
      const tier = await TierModel.create({ ...transformTierInputToAttributes(args.tier), CollectiveId: account.id });

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
      if (tier === 'custom') {
        throw new Error('Cannot delete custom tier. Set settings.disableCustomContributions to true instead.');
      }

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

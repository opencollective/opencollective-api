import { GraphQLNonNull } from 'graphql';
import { get, pick } from 'lodash';

import activities from '../../../constants/activities';
import roles from '../../../constants/roles';
import { purgeCacheForPage } from '../../../lib/cloudflare';
import { isBlacklistedCollectiveSlug } from '../../../lib/collectivelib';
import models from '../../../models';
import { Unauthorized, ValidationFailed } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { FundCreateInput } from '../input/FundCreateInput';
import { Fund } from '../object/Fund';

const DEFAULT_COLLECTIVE_SETTINGS = {
  features: { conversations: false },
  collectivePage: { sections: ['budget', 'projects', 'about'] },
};

async function createFund(_, args, req) {
  const { remoteUser, loaders } = req;

  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to create a Fund');
  }

  const fundData = {
    type: 'FUND',
    slug: args.fund.slug.toLowerCase(),
    ...pick(args.fund, ['name', 'description', 'tags']),
    isActive: false,
    CreatedByUserId: remoteUser.id,
    settings: { ...DEFAULT_COLLECTIVE_SETTINGS, ...args.fund.settings },
  };

  if (isBlacklistedCollectiveSlug(fundData.slug)) {
    throw new Error(`The slug '${fundData.slug}' is not allowed.`);
  }
  const withSlug = await models.Collective.findOne({ where: { slug: fundData.slug } });
  if (withSlug) {
    throw new Error(`The slug ${fundData.slug} is already taken. Please use another slug for your Fund.`);
  }

  let host;
  if (args.host) {
    host = await fetchAccountWithReference(args.host, { loaders });
    if (!host) {
      throw new ValidationFailed('Host Not Found');
    }
    if (!host.isHostAccount) {
      throw new ValidationFailed('Host account is not activated as Host.');
    }
  }

  const fund = await models.Collective.create(fundData);

  // Add authenticated user as an admin
  await fund.addUserWithRole(remoteUser, roles.ADMIN, { CreatedByUserId: remoteUser.id });

  // Add the host if any
  if (host) {
    await fund.addHost(host, remoteUser);
    purgeCacheForPage(`/${host.slug}`);
  }

  // Will send an email to the authenticated user
  // - tell them that their collective was successfully created
  // - tell them that their collective is pending validation (which might be wrong if it was automatically approved)
  const remoteUserCollective = await loaders.Collective.byId.load(remoteUser.CollectiveId);
  models.Activity.create({
    type: activities.COLLECTIVE_CREATED,
    UserId: remoteUser.id,
    CollectiveId: get(host, 'id'),
    data: {
      collective: fund.info,
      host: get(host, 'info'),
      user: {
        email: remoteUser.email,
        collective: remoteUserCollective.info,
      },
    },
  });

  return fund;
}

const createFundMutation = {
  type: Fund,
  args: {
    fund: {
      description: 'Information about the collective to create (name, slug, description, tags, ...)',
      type: new GraphQLNonNull(FundCreateInput),
    },
    host: {
      description: 'Reference to the host to apply on creation.',
      type: AccountReferenceInput,
    },
  },
  resolve: (_, args, req) => {
    return createFund(_, args, req);
  },
};

export default createFundMutation;

import { GraphQLNonNull } from 'graphql';
import { get, pick } from 'lodash';

import roles from '../../../constants/roles';
import { purgeCacheForCollective } from '../../../lib/cache';
import { canUseSlug } from '../../../lib/collectivelib';
import models from '../../../models';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { ValidationFailed } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLFundCreateInput } from '../input/FundCreateInput';
import { GraphQLFund } from '../object/Fund';

const DEFAULT_COLLECTIVE_SETTINGS = {
  features: { conversations: false },
  collectivePage: {
    sections: [
      {
        name: 'BUDGET',
        type: 'CATEGORY',
        isEnabled: true,
        sections: [{ name: 'budget', type: 'SECTION', isEnabled: true, restrictedTo: null }],
      },
      {
        name: 'CONTRIBUTE',
        type: 'CATEGORY',
        isEnabled: true,
        sections: [{ type: 'SECTION', name: 'projects', isEnabled: true, restrictedTo: null }],
      },
      {
        name: 'ABOUT',
        type: 'CATEGORY',
        isEnabled: true,
        sections: [{ type: 'SECTION', name: 'about', isEnabled: true, restrictedTo: null }],
      },
    ],
  },
};

async function createFund(_, args, req) {
  checkRemoteUserCanUseAccount(req);

  const fundData = {
    type: 'FUND',
    slug: args.fund.slug.toLowerCase(),
    ...pick(args.fund, ['name', 'description', 'tags']),
    isActive: false,
    CreatedByUserId: req.remoteUser.id,
    settings: { ...DEFAULT_COLLECTIVE_SETTINGS, ...args.fund.settings },
  };

  if (!canUseSlug(fundData.slug, req.remoteUser)) {
    throw new Error(`The slug '${fundData.slug}' is not allowed.`);
  }
  const withSlug = await models.Collective.findOne({ where: { slug: fundData.slug } });
  if (withSlug) {
    throw new Error(`The slug ${fundData.slug} is already taken. Please use another slug for your Fund.`);
  }

  let host;
  if (args.host) {
    host = await fetchAccountWithReference(args.host, { loaders: req.loaders });
    if (!host) {
      throw new ValidationFailed('Host Not Found');
    }
    if (!host.isHostAccount) {
      throw new ValidationFailed('Host account is not activated as Host.');
    }
  }

  const fund = await models.Collective.create(fundData);

  // Add authenticated user as an admin
  await fund.addUserWithRole(req.remoteUser, roles.ADMIN, { CreatedByUserId: req.remoteUser.id });

  // Add the host if any
  if (host) {
    await fund.addHost(host, req.remoteUser);
    purgeCacheForCollective(host.slug);
  }

  // Will send an email to the authenticated user
  // - tell them that their fund was successfully created
  // - tell them which fiscal host they picked, if any
  // - tell them the status of their host application
  const remoteUserCollective = await req.loaders.Collective.byId.load(req.remoteUser.CollectiveId);
  fund.generateCollectiveCreatedActivity(req.remoteUser, req.userToken, {
    collective: fund.info,
    host: get(host, 'info'),
    hostPending: fund.approvedAt ? false : true,
    accountType: 'fund',
    user: {
      email: req.remoteUser.email,
      collective: remoteUserCollective.info,
    },
  });

  return fund;
}

const createFundMutation = {
  type: GraphQLFund,
  description: 'Create a Fund. Scope: "account".',
  args: {
    fund: {
      description: 'Information about the collective to create (name, slug, description, tags, ...)',
      type: new GraphQLNonNull(GraphQLFundCreateInput),
    },
    host: {
      description: 'Reference to the host to apply on creation.',
      type: GraphQLAccountReferenceInput,
    },
  },
  resolve: (_, args, req) => {
    return createFund(_, args, req);
  },
};

export default createFundMutation;

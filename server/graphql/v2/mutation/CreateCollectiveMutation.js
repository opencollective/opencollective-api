import { GraphQLBoolean, GraphQLNonNull } from 'graphql';
import { get, pick } from 'lodash';

import activities from '../../../constants/activities';
import roles from '../../../constants/roles';
import { isBlacklistedCollectiveSlug } from '../../../lib/collectivelib';
import { purgeCacheForPage } from '../../../lib/cloudflare';
import * as github from '../../../lib/github';
import { defaultHostCollective } from '../../../lib/utils';
import models from '../../../models';
import { Unauthorized, ValidationFailed } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { CollectiveCreateInput } from '../input/CollectiveCreateInput';
import { Collective } from '../object/Collective';

const DEFAULT_COLLECTIVE_SETTINGS = {
  features: { conversations: true },
};

async function createCollective(_, args, req) {
  let shouldAutomaticallyApprove = false;

  const { remoteUser, loaders } = req;

  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to create a collective');
  }

  const collectiveData = {
    slug: args.collective.slug.toLowerCase(),
    ...pick(args.collective, ['name', 'description', 'tags']),
    isActive: false,
    CreatedByUserId: remoteUser.id,
    settings: { ...DEFAULT_COLLECTIVE_SETTINGS, ...args.collective.settings },
  };

  if (isBlacklistedCollectiveSlug(collectiveData.slug)) {
    throw new Error(`The slug '${collectiveData.slug}' is not allowed.`);
  }
  const collectiveWithSlug = await models.Collective.findOne({ where: { slug: collectiveData.slug } });
  if (collectiveWithSlug) {
    throw new Error(`The slug ${collectiveData.slug} is already taken. Please use another slug for your collective.`);
  }

  let host;

  // Handle GitHub automated approval and apply to the Open Source Collective Host
  if (args.automateApprovalWithGithub && args.collective.githubHandle) {
    const githubHandle = args.collective.githubHandle;
    const opensourceHost = defaultHostCollective('opensource');
    host = await loaders.Collective.byId.load(opensourceHost.CollectiveId);
    try {
      const githubAccount = await models.ConnectedAccount.findOne({
        where: { CollectiveId: remoteUser.CollectiveId, service: 'github' },
      });
      if (!githubAccount) {
        throw new Error('You must have a connected GitHub Account to create a collective with GitHub.');
      }
      // In e2e/CI environment, checkGithubAdmin and checkGithubStars will be stubbed
      await github.checkGithubAdmin(githubHandle, githubAccount.token);
      await github.checkGithubStars(githubHandle, githubAccount.token);
      shouldAutomaticallyApprove = true;
    } catch (error) {
      throw new ValidationFailed(error.message);
    }
    if (githubHandle.includes('/')) {
      collectiveData.settings.githubRepo = githubHandle;
    } else {
      collectiveData.settings.githubOrg = githubHandle;
    }
    collectiveData.tags = collectiveData.tags || [];
    if (!collectiveData.tags.includes('open source')) {
      collectiveData.tags.push('open source');
    }
  } else if (args.host) {
    host = await fetchAccountWithReference(args.host, { loaders });
    if (!host) {
      throw new ValidationFailed('Host Not Found');
    }
    if (!host.isHostAccount) {
      throw new ValidationFailed('Host account is not activated as Host.');
    }
  }

  const collective = await models.Collective.create(collectiveData);

  // Add authenticated user as an admin
  await collective.addUserWithRole(remoteUser, roles.ADMIN, { CreatedByUserId: remoteUser.id });

  // Add the host if any
  if (host) {
    await collective.addHost(host, remoteUser, { shouldAutomaticallyApprove });
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
      collective: collective.info,
      host: get(host, 'info'),
      user: {
        email: remoteUser.email,
        collective: remoteUserCollective.info,
      },
    },
  });

  return collective;
}

const createCollectiveMutation = {
  type: Collective,
  args: {
    collective: {
      description: 'Information about the collective to create (name, slug, description, tags, ...)',
      type: new GraphQLNonNull(CollectiveCreateInput),
    },
    host: {
      description: 'Reference to the host to apply on creation.',
      type: AccountReferenceInput,
    },
    automateApprovalWithGithub: {
      description: 'Wether to trigger the automated approval for Open Source collectives with GitHub.',
      type: GraphQLBoolean,
      defaultValue: false,
    },
  },
  resolve: (_, args, req) => {
    return createCollective(_, args, req);
  },
};

export default createCollectiveMutation;

import config from 'config';
import express from 'express';
import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import PersonalTokenModel from '../../../models/PersonalToken';
import { checkRemoteUserCanUseApplications } from '../../common/scope-check';
import { Forbidden, NotFound, RateLimitExceeded } from '../../errors';
import { fetchAccountWithReference } from '../input/AccountReferenceInput';
import { GraphQLPersonalTokenCreateInput } from '../input/PersonalTokenCreateInput';
import {
  fetchPersonalTokenWithReference,
  GraphQLPersonalTokenReferenceInput,
} from '../input/PersonalTokenReferenceInput';
import { GraphQLPersonalTokenUpdateInput } from '../input/PersonalTokenUpdateInput';
import { GraphQLPersonalToken } from '../object/PersonalToken';

const createPersonalToken = {
  type: new GraphQLNonNull(GraphQLPersonalToken),
  args: {
    personalToken: {
      type: new GraphQLNonNull(GraphQLPersonalTokenCreateInput),
    },
  },
  async resolve(_: void, args, req: express.Request): Promise<PersonalTokenModel> {
    checkRemoteUserCanUseApplications(req);

    const collective = args.personalToken.account
      ? await fetchAccountWithReference(args.personalToken.account, { throwIfMissing: true })
      : req.remoteUser.collective;

    // Enforce 2FA
    await twoFactorAuthLib.enforceForAccount(req, collective);

    if (!req.remoteUser.isAdminOfCollective(collective)) {
      throw new Forbidden();
    }

    const numberOfPersonalTokensForThisAccount = await models.PersonalToken.count({
      where: { CollectiveId: collective.id },
    });
    if (numberOfPersonalTokensForThisAccount >= config.limits.maxNumberOfAppsPerUser) {
      throw new RateLimitExceeded('You have reached the maximum number of personal token for this user');
    }

    const createParams = {
      ...pick(args.personalToken, ['name', 'scope', 'expiresAt', 'preAuthorize2FA']),
      CollectiveId: collective.id,
      UserId: req.remoteUser.id,
      token: models.PersonalToken.generateToken(),
    };

    return models.PersonalToken.create(createParams);
  },
};

const updatePersonalToken = {
  type: new GraphQLNonNull(GraphQLPersonalToken),
  args: {
    personalToken: {
      type: new GraphQLNonNull(GraphQLPersonalTokenUpdateInput),
    },
  },
  async resolve(_: void, args, req: express.Request): Promise<PersonalTokenModel> {
    checkRemoteUserCanUseApplications(req);

    const personalToken = await fetchPersonalTokenWithReference(args.personalToken, {
      include: [{ association: 'collective', required: true }],
    });

    if (!personalToken) {
      throw new NotFound(`Personal token not found`);
    } else if (!req.remoteUser.isAdminOfCollective(personalToken.collective)) {
      throw new Forbidden('Authenticated user is not the token owner.');
    }

    const updateParams = pick(args.personalToken, ['name', 'scope', 'expiresAt', 'preAuthorize2FA']);
    return personalToken.update(updateParams);
  },
};

const deletePersonalToken = {
  type: GraphQLPersonalToken,
  args: {
    personalToken: {
      type: new GraphQLNonNull(GraphQLPersonalTokenReferenceInput),
    },
  },
  async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
    checkRemoteUserCanUseApplications(req);

    const personalToken = await fetchPersonalTokenWithReference(args.personalToken, {
      include: [{ association: 'collective', required: true }],
    });

    if (!personalToken) {
      throw new NotFound(`Personal token not found`);
    } else if (!req.remoteUser.isAdminOfCollective(personalToken.collective)) {
      throw new Forbidden('Authenticated user is not the personal token owner.');
    }

    return personalToken.destroy();
  },
};

const personalTokenMutations = {
  createPersonalToken,
  updatePersonalToken,
  deletePersonalToken,
};

export default personalTokenMutations;

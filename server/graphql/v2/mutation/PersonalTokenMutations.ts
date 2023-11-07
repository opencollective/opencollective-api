import config from 'config';
import express from 'express';
import { GraphQLNonNull } from 'graphql';
import { isEqual, isUndefined, pick, pickBy } from 'lodash';

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
    } else if (req.personalToken) {
      throw new Error(
        'Personal tokens cannot be edited when authenticated with a personal token. Please use the interface.',
      );
    }

    const editableFields = ['name', 'scope', 'expiresAt', 'preAuthorize2FA'];
    const fieldsProtectedWith2FA = ['scope', 'expiresAt', 'preAuthorize2FA'];
    const isChange = (value, key) => editableFields.includes(key) && !isEqual(value, personalToken[key]);
    const changes = pickBy(args.personalToken, isChange);
    const hasCriticalChanges = fieldsProtectedWith2FA.some(field => !isUndefined(changes[field]));
    await twoFactorAuthLib.enforceForAccount(req, personalToken.collective, { alwaysAskForToken: hasCriticalChanges });
    return personalToken.update(changes);
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

    await twoFactorAuthLib.enforceForAccount(req, personalToken.collective);
    return personalToken.destroy();
  },
};

const personalTokenMutations = {
  createPersonalToken,
  updatePersonalToken,
  deletePersonalToken,
};

export default personalTokenMutations;

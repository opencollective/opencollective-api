import config from 'config';
import express from 'express';
import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import PersonalTokenModel from '../../../models/PersonalToken';
import { checkRemoteUserCanUseApplications } from '../../common/scope-check';
import { Forbidden, NotFound, RateLimitExceeded } from '../../errors';
import { fetchAccountWithReference } from '../input/AccountReferenceInput.js';
import { PersonalTokenCreateInput } from '../input/PersonalTokenCreateInput';
import { fetchPersonalTokenWithReference, PersonalTokenReferenceInput } from '../input/PersonalTokenReferenceInput';
import { PersonalTokenUpdateInput } from '../input/PersonalTokenUpdateInput';
import { PersonalToken } from '../object/PersonalToken';

const createPersonalToken = {
  type: PersonalToken,
  args: {
    personalToken: {
      type: new GraphQLNonNull(PersonalTokenCreateInput),
    },
  },
  async resolve(_: void, args, req: express.Request): Promise<PersonalTokenModel> {
    checkRemoteUserCanUseApplications(req);

    const collective = args.personalToken.account
      ? await fetchAccountWithReference(args.personalToken.account, { throwIfMissing: true })
      : req.remoteUser.collective;

    // Enforce 2FA
    await twoFactorAuthLib.enforceForAccountAdmins(req, collective);

    if (!req.remoteUser.isAdminOfCollective(collective)) {
      throw new Forbidden();
    }

    const numberOfPersonalTokensForThisAccount = await models.PersonalToken.count({
      where: { CollectiveId: collective.id },
    });
    if (numberOfPersonalTokensForThisAccount >= config.limits.maxNumberOfAppsPerUser) {
      throw new RateLimitExceeded('You have reached the maximum number of applications for this user');
    }

    const createParams = {
      ...pick(args.personalToken, ['name', 'scope', 'expiresAt']),
      CollectiveId: collective.id,
      UserId: req.remoteUser.id,
      token: models.PersonalToken.generateToken(),
    };

    return await models.PersonalToken.create(createParams);
  },
};

const updatePersonalToken = {
  type: PersonalToken,
  args: {
    personalToken: {
      type: new GraphQLNonNull(PersonalTokenUpdateInput),
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
      throw new Forbidden('Authenticated user is not the personal token owner.');
    }

    const updateParams = pick(args.personalToken, ['name', 'scope', 'expiresAt']);
    console.log(updateParams);
    return await personalToken.update(updateParams);
  },
};

const deletePersonalToken = {
  type: PersonalToken,
  args: {
    personalToken: {
      type: new GraphQLNonNull(PersonalTokenReferenceInput),
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

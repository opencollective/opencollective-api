import express from 'express';

import PersonalTokenModel from '../../../models/PersonalToken.js';
import { checkRemoteUserCanUseApplications } from '../../common/scope-check.js';
import { Forbidden, NotFound } from '../../errors.js';
import { fetchPersonalTokenWithReference, PersonalTokenReferenceFields } from '../input/PersonalTokenReferenceInput.js';
import { GraphQLPersonalToken } from '../object/PersonalToken.js';

const PersonalTokenQuery = {
  type: GraphQLPersonalToken,
  description: 'Get a personal token by reference',
  args: {
    ...PersonalTokenReferenceFields,
  },
  async resolve(_: void, args, req: express.Request): Promise<PersonalTokenModel> {
    checkRemoteUserCanUseApplications(req);

    const personalToken = await fetchPersonalTokenWithReference(args, {
      include: [{ association: 'collective', required: true }],
    });

    if (!personalToken) {
      throw new NotFound(`Personal token not found`);
    } else if (!req.remoteUser.isAdminOfCollective(personalToken.collective)) {
      throw new Forbidden('Authenticated user is not the personal token owner.');
    }

    return personalToken;
  },
};

export default PersonalTokenQuery;

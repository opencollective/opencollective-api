import express from 'express';

import PersonalTokenModel from '../../../models/PersonalToken';
import { checkRemoteUserCanUseApplications } from '../../common/scope-check';
import { Forbidden, NotFound } from '../../errors';
import { fetchPersonalTokenWithReference, PersonalTokenReferenceFields } from '../input/PersonalTokenReferenceInput';
import { GraphQLPersonalToken } from '../object/PersonalToken';

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

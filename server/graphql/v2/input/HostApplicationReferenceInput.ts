import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import models, { HostApplication } from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

interface HostApplcationReferenceInputFields {
  id?: string;
}

export const GraphQLHostApplicationReferenceInput = new GraphQLInputObjectType({
  name: 'HostApplicationReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the host application (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
  }),
});

export const getDatabaseIdFromHostApplicationReference = (input: HostApplcationReferenceInputFields): number => {
  return idDecode(input['id'], IDENTIFIER_TYPES.HOST_APPLICATION);
};

/**
 * Retrieve an host application from an `HostApplicationReferenceInput`
 */
export const fetchHostApplicationWithReference = async (
  input: HostApplcationReferenceInputFields,
  { loaders = null, throwIfMissing = false } = {},
): Promise<HostApplication> => {
  const dbId = getDatabaseIdFromHostApplicationReference(input);
  let hostApplication = null;
  if (dbId) {
    hostApplication = await (loaders ? loaders.HostApplication.byId.load(dbId) : models.HostApplication.findByPk(dbId));
  }

  if (!hostApplication && throwIfMissing) {
    throw new NotFound();
  }

  return hostApplication;
};

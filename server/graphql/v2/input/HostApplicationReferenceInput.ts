import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import models, { HostApplication } from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

interface HostApplcationReferenceInputFields {
  publicId?: string;
  id?: string;
}

export const GraphQLHostApplicationReferenceInput = new GraphQLInputObjectType({
  name: 'HostApplicationReferenceInput',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${HostApplication.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: {
      type: GraphQLString,
      description: 'The public id identifying the host application (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
  }),
});

export const getDatabaseIdFromHostApplicationReference = (input: HostApplcationReferenceInputFields): number => {
  if (input.id) {
    return idDecode(input['id'], IDENTIFIER_TYPES.HOST_APPLICATION);
  } else {
    return null;
  }
};

/**
 * Retrieve an host application from an `HostApplicationReferenceInput`
 */
export const fetchHostApplicationWithReference = async (
  input: HostApplcationReferenceInputFields,
  { loaders = null, throwIfMissing = false } = {},
): Promise<HostApplication> => {
  let hostApplication = null;
  if (input.publicId) {
    const expectedPrefix = HostApplication.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for HostApplication, expected prefix ${expectedPrefix}_`);
    }

    hostApplication = await models.HostApplication.findOne({ where: { publicId: input.publicId } });
  } else {
    const dbId = getDatabaseIdFromHostApplicationReference(input);
    if (dbId) {
      hostApplication = await (loaders
        ? loaders.HostApplication.byId.load(dbId)
        : models.HostApplication.findByPk(dbId));
    }
  }

  if (!hostApplication && throwIfMissing) {
    throw new NotFound();
  }

  return hostApplication;
};

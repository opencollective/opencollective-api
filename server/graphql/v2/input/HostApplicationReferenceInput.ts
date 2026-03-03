import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
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
      description: `The public id identifying the host application (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re, ${EntityShortIdPrefix.HostApplication}_xxxxxxxx)`,
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
  if (isEntityPublicId(input.id, EntityShortIdPrefix.HostApplication)) {
    hostApplication = await models.HostApplication.findOne({ where: { publicId: input.id } });
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

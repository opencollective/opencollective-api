import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import models, { type Application } from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const ApplicationReferenceFields = {
  id: {
    type: GraphQLString,
    description: `The public id identifying the application (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re, ${EntityShortIdPrefix.Application}_xxxxxxxx)`,
  },
  legacyId: {
    type: GraphQLInt,
    description: 'The legacy public id identifying the application (ie: 4242)',
    deprecationReason: '2026-02-25: use id',
  },
  clientId: {
    type: GraphQLString,
    description: 'The clientId for the application.',
  },
};

export const GraphQLApplicationReferenceInput = new GraphQLInputObjectType({
  name: 'ApplicationReferenceInput',
  fields: () => ApplicationReferenceFields,
});

export type ApplicationReferenceInput = {
  id?: string;
  legacyId?: number;
  clientId?: string;
};

/**
 * Retrieves an application
 *
 * @param {object} input - id of the application
 */
export const fetchApplicationWithReference = async (
  input: ApplicationReferenceInput,
  sequelizeOps: Parameters<typeof models.Application.findByPk>[1] = {},
): Promise<Application> => {
  let application;
  if (isEntityPublicId(input.id, EntityShortIdPrefix.Application)) {
    application = await models.Application.findOne({ ...sequelizeOps, where: { publicId: input.id } });
  } else if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.APPLICATION);
    application = await models.Application.findByPk(id, sequelizeOps);
  } else if (input.legacyId) {
    application = await models.Application.findByPk(input.legacyId, sequelizeOps);
  } else if (input.clientId) {
    application = await models.Application.findOne({ ...sequelizeOps, where: { clientId: input.clientId } });
  } else {
    throw new Error('Please provide an id');
  }
  if (!application) {
    throw new NotFound('Application Not Found');
  }
  return application;
};

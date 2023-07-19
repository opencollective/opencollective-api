import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models/index.js';
import { NotFound } from '../../errors.js';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers.js';

export const ApplicationReferenceFields = {
  id: {
    type: GraphQLString,
    description: 'The public id identifying the application (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
  },
  legacyId: {
    type: GraphQLInt,
    description: 'The legacy public id identifying the application (ie: 4242)',
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

/**
 * Retrieves an application
 *
 * @param {object} input - id of the application
 */
export const fetchApplicationWithReference = async (input, sequelizeOps = undefined) => {
  let application;
  if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.APPLICATION);
    application = await models.Application.findByPk(id, sequelizeOps);
  } else if (input.legacyId) {
    application = await models.Application.findByPk(input.legacyId, sequelizeOps);
  } else if (input.clientId) {
    application = await models.Application.findOne({ where: { clientId: input.clientId } }, sequelizeOps);
  } else {
    throw new Error('Please provide an id');
  }
  if (!application) {
    throw new NotFound('Application Not Found');
  }
  return application;
};

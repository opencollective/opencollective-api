// ignore unused exports fetchUpdateWithReference

import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

/**
 * An input for referencing Updates.
 */
const GraphQLUpdateReferenceInput = new GraphQLInputObjectType({
  name: 'UpdateReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the update',
    },
  }),
});

const getDatabaseIdFromUpdateReference = input => {
  if (input['id']) {
    return idDecode(input['id'], IDENTIFIER_TYPES.UPDATE);
  } else if (input['legacyId']) {
    return input['legacyId'];
  } else {
    return null;
  }
};

/**
 * Retrieve an expense from an `UpdateReferenceInput`
 */
const fetchUpdateWithReference = async (input, { loaders = null, throwIfMissing = false } = {}) => {
  const dbId = getDatabaseIdFromUpdateReference(input);
  let update = null;
  if (dbId) {
    update = await (loaders ? loaders.Update.byId.load(dbId) : models.Update.findByPk(dbId));
  }

  if (!update && throwIfMissing) {
    throw new NotFound();
  }

  return update;
};

export { GraphQLUpdateReferenceInput, fetchUpdateWithReference, getDatabaseIdFromUpdateReference };

import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import models, { type Update } from '../../../models';
import { NotFound } from '../../errors';
import { Loaders } from '../../loaders';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

/**
 * An input for referencing Updates.
 */
export const GraphQLUpdateReferenceInput = new GraphQLInputObjectType({
  name: 'UpdateReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: `The public id identifying the update (ie: ${EntityShortIdPrefix.Update}_xxxxxxxx)`,
    },
  }),
});

type UpdateReferenceInputGraphQLType = { id?: string; legacyId?: number };

export const getDatabaseIdFromUpdateReference = async (
  input: UpdateReferenceInputGraphQLType,
  { loaders = null }: { loaders?: Loaders } = {},
): Promise<number | null> => {
  if (isEntityPublicId(input.id, EntityShortIdPrefix.Update)) {
    return (
      loaders
        ? loaders.Update.byPublicId.load(input.id)
        : models.Update.findOne({ where: { publicId: input.id }, attributes: ['id'] })
    ).then(update => {
      if (!update) {
        throw new NotFound(`Update with public id ${input.id} not found`);
      }
      return update.id;
    });
  } else if (input['id']) {
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
// ts-unused-exports:disable-next-line
export const fetchUpdateWithReference = async (
  input: UpdateReferenceInputGraphQLType,
  { loaders = null, throwIfMissing = false }: { loaders?: Loaders; throwIfMissing?: boolean } = {},
): Promise<Update | null> => {
  let update: Update | null = null;
  if (isEntityPublicId(input.id, EntityShortIdPrefix.Update)) {
    update = await (loaders
      ? loaders.Update.byPublicId.load(input.id)
      : models.Update.findOne({ where: { publicId: input.id } }));
  } else {
    const dbId = await getDatabaseIdFromUpdateReference(input, { loaders });
    if (dbId) {
      update = await (loaders ? loaders.Update.byId.load(dbId) : models.Update.findByPk(dbId));
    }
  }

  if (!update && throwIfMissing) {
    throw new NotFound();
  }

  return update;
};

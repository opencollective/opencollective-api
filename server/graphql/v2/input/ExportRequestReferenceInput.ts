import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import ExportRequest from '../../../models/ExportRequest';
import { NotFound } from '../../errors';
import { Loaders } from '../../loaders';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLExportRequestReferenceInput = new GraphQLInputObjectType({
  name: 'ExportRequestReferenceInput',
  description: 'Input type for referencing an ExportRequest',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: `The public id identifying the export request (ie: ${EntityShortIdPrefix.ExportRequest}_xxxxxxxx)`,
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the export request',
      deprecationReason: '2026-02-25: use id',
    },
  }),
});

type ExportRequestReferenceInputType = {
  id?: string;
  legacyId?: number;
};

export const fetchExportRequestWithReference = async (
  input: ExportRequestReferenceInputType,
  opts?: { throwIfMissing?: boolean; loaders?: Loaders },
): Promise<ExportRequest | null> => {
  if (!input.id && !input.legacyId) {
    throw new Error('Please provide a id or a legacyId');
  }

  if (isEntityPublicId(input.id, EntityShortIdPrefix.ExportRequest)) {
    const exportRequest = await (opts?.loaders
      ? opts.loaders.ExportRequest.byPublicId.load(input.id)
      : ExportRequest.findOne({ where: { publicId: input.id } }));
    if (exportRequest) {
      return exportRequest;
    }

    if (opts?.throwIfMissing) {
      throw new NotFound('ExportRequest Not Found');
    }

    return null;
  }

  const legacyId = input.legacyId || idDecode(input.id, IDENTIFIER_TYPES.EXPORT_REQUEST);
  const exportRequest = await ExportRequest.findByPk(legacyId);

  if (exportRequest) {
    return exportRequest;
  }

  if (opts?.throwIfMissing) {
    throw new NotFound('ExportRequest Not Found');
  }

  return null;
};

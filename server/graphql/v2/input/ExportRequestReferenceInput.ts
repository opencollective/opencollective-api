import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import ExportRequest from '../../../models/ExportRequest';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLExportRequestReferenceInput = new GraphQLInputObjectType({
  name: 'ExportRequestReferenceInput',
  description: 'Input type for referencing an ExportRequest',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the export request',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the export request',
    },
  }),
});

type ExportRequestReferenceInputType = {
  id?: string;
  legacyId?: number;
};

export const fetchExportRequestWithReference = async (
  input: ExportRequestReferenceInputType,
  opts?: { throwIfMissing?: boolean },
): Promise<ExportRequest | null> => {
  if (!input.id && !input.legacyId) {
    throw new Error('Please provide an id or a legacyId');
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

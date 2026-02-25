import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import ExportRequest from '../../../models/ExportRequest';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLExportRequestReferenceInput = new GraphQLInputObjectType({
  name: 'ExportRequestReferenceInput',
  description: 'Input type for referencing an ExportRequest',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${ExportRequest.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: {
      type: GraphQLString,
      description: 'The public id identifying the export request',
      deprecationReason: '2026-02-25: use publicId',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the export request',
      deprecationReason: '2026-02-25: use publicId',
    },
  }),
});

type ExportRequestReferenceInputType = {
  publicId?: string;
  id?: string;
  legacyId?: number;
};

export const fetchExportRequestWithReference = async (
  input: ExportRequestReferenceInputType,
  opts?: { throwIfMissing?: boolean },
): Promise<ExportRequest | null> => {
  if (!input.publicId && !input.id && !input.legacyId) {
    throw new Error('Please provide a publicId, id or a legacyId');
  }

  if (input.publicId) {
    const expectedPrefix = ExportRequest.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for ExportRequest, expected prefix ${expectedPrefix}_`);
    }

    const exportRequest = await ExportRequest.findOne({ where: { publicId: input.publicId } });
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

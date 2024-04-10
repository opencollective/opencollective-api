import config from 'config';
import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLLegalDocumentRequestStatus } from '../enum/LegalDocumentRequestStatus';
import { GraphQLLegalDocumentService } from '../enum/LegalDocumentService';
import { GraphQLLegalDocumentType } from '../enum/LegalDocumentType';
import { getIdEncodeResolver, idEncode, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';
import GraphQLURL from '../scalar/URL';

export const GraphQLLegalDocument = new GraphQLObjectType({
  name: 'LegalDocument',
  description: 'A legal document (e.g. W9, W8BEN, W8BEN-E)',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this legal document',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.LEGAL_DOCUMENT),
    },
    year: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'The year this legal document is for',
    },
    type: {
      type: new GraphQLNonNull(GraphQLLegalDocumentType),
      description: 'The type of legal document',
      resolve: ({ documentType }) => documentType,
    },
    status: {
      type: new GraphQLNonNull(GraphQLLegalDocumentRequestStatus),
      description: 'The status of the request for this legal document',
      resolve: ({ requestStatus }) => requestStatus,
    },
    service: {
      type: new GraphQLNonNull(GraphQLLegalDocumentService),
      description: 'The service that provided this legal document',
    },
    requestedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date and time the request for this legal document was created',
      resolve: ({ createdAt }) => createdAt,
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date and time this legal document was last updated',
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      description: 'The account this legal document is for',
    },
    documentLink: {
      type: GraphQLURL,
      description:
        'URL to download the file. Must be logged in as an account admin. The returned URL will be protected by authentication + 2FA.',
      resolve: async (document, _, req) => {
        if (document.documentLink && req.remoteUser) {
          const account = await req.loaders.Collective.byId.load(document.CollectiveId);
          if (req.remoteUser.isAdminOfCollective(account)) {
            return `${config.host.api}/legal-documents/${idEncode(document.id, 'legal-document')}/download`;
          }
        }
      },
    },
  }),
});

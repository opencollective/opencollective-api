import { GraphQLEnumType } from 'graphql';

import { LEGAL_DOCUMENT_REQUEST_STATUS } from '../../../models/LegalDocument';

export const GraphQLLegalDocumentRequestStatus = new GraphQLEnumType({
  name: 'LegalDocumentRequestStatus',
  description: 'Status for a legal document',
  values: Object.values(LEGAL_DOCUMENT_REQUEST_STATUS).reduce((values, value) => {
    values[value] = { value };
    return values;
  }, {}),
});

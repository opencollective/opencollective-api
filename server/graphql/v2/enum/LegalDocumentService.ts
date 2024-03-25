import { GraphQLEnumType } from 'graphql';

import { LEGAL_DOCUMENT_SERVICE } from '../../../models/LegalDocument';

export const GraphQLLegalDocumentService = new GraphQLEnumType({
  name: 'LegalDocumentService',
  description: 'Type for a required legal document',
  values: Object.values(LEGAL_DOCUMENT_SERVICE).reduce((values, value) => {
    values[value] = { value };
    return values;
  }, {}),
});

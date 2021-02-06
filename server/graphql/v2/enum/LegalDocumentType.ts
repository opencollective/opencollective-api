import { GraphQLEnumType } from 'graphql';

import { LEGAL_DOCUMENT_TYPE } from '../../../models/LegalDocument';

export const LegalDocumentType = new GraphQLEnumType({
  name: 'LegalDocumentType',
  description: 'Type for a required legal document',
  values: {
    [LEGAL_DOCUMENT_TYPE.US_TAX_FORM]: {
      description: 'US tax form (W9)',
    },
  },
});

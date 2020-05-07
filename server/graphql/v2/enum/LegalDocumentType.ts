import { GraphQLEnumType } from 'graphql';

import { LEGAL_DOCUMENT_TYPE } from '../../../models/LegalDocument';

export const LegalDocumentType = new GraphQLEnumType({
  name: 'LegalDocumentType',
  description: 'US tax form (W9)',
  values: {
    [LEGAL_DOCUMENT_TYPE.US_TAX_FORM]: {
      description: 'Invoice: Get paid back for a purchase already made.',
    },
  },
});

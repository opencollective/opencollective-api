import { GraphQLScalarType } from 'graphql';

import { EntityShortIdPrefix } from '../../../lib/permalink/entity-map';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLKYCVerificationReferenceInput = new GraphQLScalarType({
  name: 'KYCVerificationReferenceInput',
  description: 'A reference to a KYC Verification',
  parseValue(value: unknown): number | string {
    if (typeof value === 'string' && value.startsWith(`${EntityShortIdPrefix.KYCVerification}_`)) {
      return value;
    } else if (typeof value === 'string') {
      return idDecode(value, IDENTIFIER_TYPES.KYC_VERIFICATION);
    } else if (typeof value === 'number') {
      return value;
    }

    throw new Error('invalid input for KYCVerificationReferenceInput');
  },
});

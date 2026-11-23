import '../../../../../server/graphql/v2/schema'; // Load the full schema first to resolve circular imports

import { expect } from 'chai';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql';

import { GraphQLLegalDocument } from '../../../../../server/graphql/v2/object/LegalDocument';
import models from '../../../../../server/models';
import { LEGAL_DOCUMENT_REQUEST_STATUS } from '../../../../../server/models/LegalDocument';

const queryLegalDocument = async (requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS) => {
  const document = models.LegalDocument.build({ year: 2020, documentType: 'US_TAX_FORM', requestStatus });
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { legalDocument: { type: GraphQLLegalDocument, resolve: () => document } },
    }),
  });

  const result = await graphql({ schema, source: '{ legalDocument { status isExpired } }' });
  expect(result.errors).to.not.exist;
  return result.data.legalDocument as { status: string; isExpired: boolean };
};

describe('server/graphql/v2/object/LegalDocument', () => {
  describe('isExpired', () => {
    it('is true when the request status is EXPIRED', async () => {
      const result = await queryLegalDocument(LEGAL_DOCUMENT_REQUEST_STATUS.EXPIRED);
      expect(result.status).to.eq('EXPIRED');
      expect(result.isExpired).to.be.true;
    });

    it('is false for other request statuses', async () => {
      for (const status of [LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED, LEGAL_DOCUMENT_REQUEST_STATUS.REQUESTED]) {
        const result = await queryLegalDocument(status);
        expect(result.status).to.eq(status);
        expect(result.isExpired).to.be.false;
      }
    });
  });
});

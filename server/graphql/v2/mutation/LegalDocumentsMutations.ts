import { GraphQLNonNull } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { LegalDocument } from '../../../models';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { Forbidden, ValidationFailed } from '../../errors';
import { GraphQLLegalDocumentType } from '../enum/LegalDocumentType';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLLegalDocument } from '../object/LegalDocument';

export const legalDocumentsMutations = {
  submitLegalDocument: {
    type: new GraphQLNonNull(GraphQLLegalDocument),
    description: 'Submit a legal document',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account the legal document is for',
      },
      type: {
        type: new GraphQLNonNull(GraphQLLegalDocumentType),
        description: 'The type of legal document',
      },
      formData: {
        type: new GraphQLNonNull(GraphQLJSON),
        description:
          'The form data for the legal document. Will be validated against the schema for the document type and encrypted.',
      },
    },
    resolve: async (_, args, req) => {
      checkRemoteUserCanUseAccount(req);
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden('You do not have permission to submit a legal document for this account');
      }

      if (args.type === 'US_TAX_FORM') {
        // Make sure we don't already have a valid tax form for this account
        const existingTaxForms = await LegalDocument.findAll({
          order: [['createdAt', 'DESC']],
          where: { CollectiveId: account.id, documentType: 'US_TAX_FORM' },
        });

        if (existingTaxForms.some(ld => ld.requestStatus === 'RECEIVED')) {
          throw new ValidationFailed('A tax form has already been submitted for this account');
        }

        // Create form
        const currentYear = new Date().getFullYear();
        const request = existingTaxForms[0];
        return LegalDocument.createUSTaxFromFromData(currentYear, account, args.formData, request);
      } else {
        throw new ValidationFailed(`Legal document type ${args.type} is not supported`);
      }
    },
  },
};

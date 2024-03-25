import assert from 'assert';

import debugLib from 'debug';
import { GraphQLNonNull } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { encodeBase64 } from 'tweetnacl-util';

import ActivityTypes from '../../../constants/activities';
import { notify } from '../../../lib/notifications/email';
import { getUSTaxFormPdf } from '../../../lib/pdf';
import { reportErrorToSentry } from '../../../lib/sentry';
import { encryptAndUploadTaxFormToS3 } from '../../../lib/tax-forms';
import { Activity, LegalDocument } from '../../../models';
import { LEGAL_DOCUMENT_REQUEST_STATUS, LEGAL_DOCUMENT_SERVICE } from '../../../models/LegalDocument';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { Forbidden, ValidationFailed } from '../../errors';
import { GraphQLLegalDocumentType } from '../enum/LegalDocumentType';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLLegalDocument } from '../object/LegalDocument';

const debug = debugLib('legalDocuments');

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
      if (!req.remoteUser) {
        throw new Forbidden('You need to be logged in to submit a legal document');
      }

      checkRemoteUserCanUseAccount(req);
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden('You do not have permission to submit a legal document for this account');
      }

      if (args.type === 'US_TAX_FORM') {
        // Some validation on form data
        const formType = args.formData.formType;
        assert(formType, 'Form type is required');
        assert(['W9', 'W8_BEN', 'W8_BEN_E'].includes(formType), 'Invalid form type');

        // Make sure we don't already have a valid tax form for this account
        const existingLegalDocuments = await LegalDocument.findAll({
          order: [['createdAt', 'DESC']],
          where: { CollectiveId: account.id, documentType: 'US_TAX_FORM' },
        });

        if (existingLegalDocuments.some(ld => ld.requestStatus === LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED)) {
          throw new ValidationFailed('A tax form has already been submitted for this account');
        } else if (!existingLegalDocuments.length) {
          throw new ValidationFailed('No tax form request found for this account');
        }

        // Generate PDF and store it on S3
        const legalDocument = existingLegalDocuments[0];
        const valuesHash = LegalDocument.hash(args.formData);
        debug('Generate tax form PDF');
        const pdfFile = await getUSTaxFormPdf(formType, args.formData);
        debug('Encrypt and upload tax form to S3');
        const { url } = await encryptAndUploadTaxFormToS3(pdfFile, account, legalDocument.year, valuesHash);

        // Update legal document
        debug('Update legal document');
        await legalDocument.update({
          service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
          requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
          documentLink: url,
          data: {
            ...legalDocument.data,
            valuesHash,
            encryptedFormData: encodeBase64(LegalDocument.encrypt(Buffer.from(JSON.stringify(args.formData)))),
          },
        });

        try {
          debug('Create activity');
          const activity = await Activity.create({
            type: ActivityTypes.TAXFORM_RECEIVED,
            UserId: req.remoteUser.id,
            CollectiveId: account.id,
            FromCollectiveId: req.remoteUser.CollectiveId,
            UserTokenId: req.useToken?.id,
            data: {
              service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
              type: formType,
              document: legalDocument.info,
              account: account.info,
              valuesHash,
            },
          });

          // To prevent having to re-download + decrypt the tax form, we send the file by email directly while it's still in memory
          debug('Send email');
          await notify.user(activity, {
            attachments: [{ filename: url.split('/').pop(), content: pdfFile }],
          });
        } catch (e) {
          reportErrorToSentry(e, { req });
        }

        return legalDocument;
      } else {
        throw new ValidationFailed(`Legal document type ${args.type} is not supported`);
      }
    },
  },
};

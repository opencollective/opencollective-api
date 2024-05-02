import assert from 'assert';

import debugLib from 'debug';
import { GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';
import GraphQLUpload from 'graphql-upload/GraphQLUpload.js';
import { FileUpload } from 'graphql-upload/Upload';
import { encodeBase64 } from 'tweetnacl-util';

import ActivityTypes from '../../../constants/activities';
import { notify } from '../../../lib/notifications/email';
import { getUSTaxFormPdf } from '../../../lib/pdf';
import { reportErrorToSentry } from '../../../lib/sentry';
import { encryptAndUploadTaxFormToS3 } from '../../../lib/tax-forms';
import { Activity, LegalDocument, UploadedFile } from '../../../models';
import {
  LEGAL_DOCUMENT_REQUEST_STATUS,
  LEGAL_DOCUMENT_SERVICE,
  LEGAL_DOCUMENT_TYPE,
  US_TAX_FORM_TYPES,
} from '../../../models/LegalDocument';
import { checkRemoteUserCanUseAccount, checkRemoteUserCanUseHost } from '../../common/scope-check';
import { Forbidden, ValidationFailed } from '../../errors';
import { GraphQLLegalDocumentRequestStatus } from '../enum/LegalDocumentRequestStatus';
import { GraphQLLegalDocumentType } from '../enum/LegalDocumentType';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import {
  AccountReferenceInput,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../input/AccountReferenceInput';
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
      } else if (args.type !== LEGAL_DOCUMENT_TYPE.US_TAX_FORM) {
        throw new ValidationFailed(`Legal document type ${args.type} is not supported`);
      }

      // Some validation on form data
      const formType = args.formData.formType;
      assert(formType, 'Form type is required');
      assert(US_TAX_FORM_TYPES.includes(formType), 'Invalid form type');

      // Make sure we don't already have a valid tax form for this account
      const existingLegalDocuments = await LegalDocument.findAll({
        order: [['createdAt', 'DESC']],
        where: { CollectiveId: account.id, documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM },
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
        year: new Date().getFullYear(), // Legal documents are always provided for the current year
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
    },
  },
  editLegalDocumentStatus: {
    type: new GraphQLNonNull(GraphQLLegalDocument),
    description: 'Edit the status of a legal document',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The ID of the legal document',
      },
      status: {
        type: new GraphQLNonNull(GraphQLLegalDocumentRequestStatus),
        description: 'The new status of the legal document',
      },
      host: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The host of the legal document',
      },
      message: {
        type: GraphQLString,
        description: 'A message to explain the change in status. Will be sent to the legal document submitter',
      },
      file: {
        type: GraphQLUpload,
        description: 'The new document link for the legal document. Must pass status=RECEIVED.',
      },
    },
    resolve: async (
      _,
      args: {
        id: string;
        status: LEGAL_DOCUMENT_REQUEST_STATUS;
        host: AccountReferenceInput;
        message?: string;
        file?: Promise<FileUpload>;
      },
      req: Express.Request,
    ) => {
      checkRemoteUserCanUseHost(req);
      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
      const decodedDocumentId = idDecode(args.id, IDENTIFIER_TYPES.LEGAL_DOCUMENT);
      const legalDocument = await LegalDocument.findByPk(decodedDocumentId, {
        include: [{ association: 'collective', required: true }],
      });

      if (!legalDocument) {
        throw new ValidationFailed('Legal document not found');
      } else if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Forbidden('You do not have permission to edit legal documents for this host');
      } else if (!(await legalDocument.isAccessibleByHost(host))) {
        throw new Forbidden('You do not have permission to edit this legal document');
      } else if (args.status === LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED) {
        const supportedDocumentTypes = [LEGAL_DOCUMENT_REQUEST_STATUS.ERROR, LEGAL_DOCUMENT_REQUEST_STATUS.REQUESTED];
        if (!(supportedDocumentTypes as string[]).includes(legalDocument.requestStatus)) {
          throw new ValidationFailed('Legal document must be in error or requested status to be marked as received');
        }

        const file = args.file && (await args.file);
        assert(file, new ValidationFailed('A file is required when setting the status to received'));
        const fileUpload = await UploadedFile.getFileUploadFromGraphQLUpload(file);

        UploadedFile.validateFile(fileUpload, ['application/pdf'], ValidationFailed);

        const { url } = await encryptAndUploadTaxFormToS3(
          fileUpload.buffer,
          legalDocument.collective,
          legalDocument.year,
        );

        return legalDocument.update({
          service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
          requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
          documentLink: url,
          data: {
            ...legalDocument.data,
            isManual: true,
          },
        });
      } else if (args.status === LEGAL_DOCUMENT_REQUEST_STATUS.INVALID) {
        assert(args.message, new ValidationFailed('A message is required when setting the status to error'));
        assert(
          legalDocument.requestStatus === LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
          new ValidationFailed('Legal document must be received to be marked as invalid'),
        );

        return legalDocument.markAsInvalid(req.remoteUser, host, args.message, { UserTokenId: req.userToken?.id });
      } else {
        throw new ValidationFailed(
          `Updating a ${legalDocument.requestStatus} legal document to ${args.status} is not allowed`,
        );
      }
    },
  },
};

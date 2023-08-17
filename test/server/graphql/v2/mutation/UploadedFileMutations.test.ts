import axios from 'axios';
import { expect } from 'chai';
import config from 'config';
import gqlV2 from 'fake-tag';
import sinon from 'sinon';
import { v4 as uuid } from 'uuid';

import { SUPPORTED_FILE_KINDS } from '../../../../../server/constants/file-kind';
import * as awsS3Lib from '../../../../../server/lib/awsS3';
import * as ExpenseOCRLib from '../../../../../server/lib/ocr/index';
import { klippaSuccessInvoice } from '../../../../../server/lib/ocr/klippa/mocks';
import { fakeUser } from '../../../../test-helpers/fake-data';
import { getMockFileUpload, graphqlQueryV2 } from '../../../../utils';

const uploadFileMutation = gqlV2/* GraphQL */ `
  mutation UploadFile($files: [UploadFileInput!]!) {
    uploadFile(files: $files) {
      file {
        id
        url
        name
        type
        size
      }
      parsingResult {
        success
        message
        expense {
          confidence
          description
          date
          amount {
            valueInCents
            currency
          }
          items {
            description
            incurredAt
            url
            amount {
              valueInCents
              currency
            }
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/mutation/UploadedFileMutations', () => {
  let sandbox, uploadToS3Stub;

  before(() => {
    sandbox = sinon.createSandbox();
  });

  beforeEach(() => {
    // Mock S3
    sandbox.stub(awsS3Lib, 'checkS3Configured').returns(true);
    uploadToS3Stub = sandbox.stub(awsS3Lib, 'uploadToS3').callsFake(() => ({
      Location: `https://opencollective-test.s3.us-west-1.amazonaws.com/expense-item/${uuid()}.pdf`,
    }));
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('uploadFile', () => {
    it('must be logged in', async () => {
      const args = { files: [{ kind: 'EXPENSE_ITEM', file: getMockFileUpload() }] };
      const result = await graphqlQueryV2(uploadFileMutation, args);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('You need to be logged in to upload files');
    });

    it('simply uploads a file', async () => {
      const user = await fakeUser();
      const args = { files: [{ kind: 'EXPENSE_ITEM', file: getMockFileUpload() }] };
      const result = await graphqlQueryV2(uploadFileMutation, args, user);

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(uploadToS3Stub.callCount).to.eq(1);
      expect(result.data.uploadFile[0].parsingResult).to.be.null;
      expect(result.data.uploadFile[0].file.name).to.eq('camera.png');
      expect(result.data.uploadFile[0].file.type).to.eq('image/png');
      expect(result.data.uploadFile[0].file.size).to.eq(3628);
    });

    describe('with parseDocument', () => {
      it('can only use the option with EXPENSE_ITEM and EXPENSE_ATTACHED_FILE', async () => {
        const user = await fakeUser();
        const unsupportedKinds = SUPPORTED_FILE_KINDS.filter(
          k => k !== 'EXPENSE_ITEM' && k !== 'EXPENSE_ATTACHED_FILE',
        );
        for (const kind of unsupportedKinds) {
          const args = { files: [{ file: getMockFileUpload(), kind, parseDocument: true }] };
          const result = await graphqlQueryV2(uploadFileMutation, args, user);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.eq(
            `This mutation only supports the following kinds: EXPENSE_ITEM, EXPENSE_ATTACHED_FILE`,
          );
        }
      });

      it('does not crash but returns a proper error if parsing fails', async () => {
        // Mock OCR service with something that always fails
        sandbox.stub(ExpenseOCRLib, 'getExpenseOCRParser').returns({
          processUrl: () => {
            throw new Error('OCR parsing failed on purpose for test');
          },
        });

        const user = await fakeUser();
        const args = { files: [{ kind: 'EXPENSE_ITEM', file: getMockFileUpload(), parseDocument: true }] };
        const result = await graphqlQueryV2(uploadFileMutation, args, user);
        expect(uploadToS3Stub.callCount).to.eq(1);
        expect(result.errors).to.not.exist;
        expect(result.data.uploadFile[0].parsingResult).to.deep.eq({
          success: false,
          message: 'Could not parse document: OCR parsing failed on purpose for test',
          expense: null,
        });
      });

      // Since Klippa is not configured, the mock service is used by default
      describe('mocked service', () => {
        it('is used by default', async () => {
          const user = await fakeUser();
          const args = { files: [{ kind: 'EXPENSE_ITEM', file: getMockFileUpload(), parseDocument: true }] };
          const result = await graphqlQueryV2(uploadFileMutation, args, user);
          expect(result.errors).to.not.exist;
          expect(uploadToS3Stub.callCount).to.eq(1);
          expect(result.data.uploadFile[0].parsingResult).to.not.be.null;
          expect(result.data.uploadFile[0].parsingResult).to.containSubset({
            success: true,
            message: null,
            expense: {
              amount: { valueInCents: 65e2, currency: 'USD' },
              confidence: 100,
              date: '2023-08-01',
              description: 'Render invoice',
              items: [
                {
                  amount: {
                    currency: 'USD',
                    valueInCents: 0,
                  },
                  description: 'Static Sites - 743h 59m 59s - 1 instance',
                  incurredAt: '2023-08-01',
                },
                {
                  amount: {
                    currency: 'USD',
                    valueInCents: 3200,
                  },
                  description: 'Servers - 2,231h 59m 57s - 3 instances',
                  incurredAt: '2023-08-01',
                },
                {
                  amount: {
                    currency: 'USD',
                    valueInCents: 1400,
                  },
                  description: 'PostgresDB - 1,487h 59m 58s - 2 instances',
                  incurredAt: '2023-08-01',
                },
                {
                  amount: {
                    currency: 'USD',
                    valueInCents: 1900,
                  },
                  description: 'Team Plan - 1 user',
                  incurredAt: '2023-08-01',
                },
              ],
            },
          });
        });

        it('is not used in production', async () => {
          sandbox.stub(config, 'env').value('production');
          const user = await fakeUser();
          const args = { files: [{ kind: 'EXPENSE_ITEM', file: getMockFileUpload(), parseDocument: true }] };
          const result = await graphqlQueryV2(uploadFileMutation, args, user);
          expect(result.errors).to.not.exist;
          expect(result.data.uploadFile[0].parsingResult).to.deep.eq({
            success: false,
            message: 'OCR parsing is not available',
            expense: null,
          });
        });
      });

      describe('using Klippa', () => {
        beforeEach(() => {
          sandbox.stub(config, 'klippa').value({ enabled: true, apiKey: 'TEST' });
        });

        it('calls Klippa with the file and formats the result', async () => {
          // Initialize nock
          sandbox.stub(axios, 'post').resolves({ data: klippaSuccessInvoice, status: 200 });

          // Trigger query
          const user = await fakeUser();
          const args = { files: [{ kind: 'EXPENSE_ITEM', file: getMockFileUpload(), parseDocument: true }] };
          const result = await graphqlQueryV2(uploadFileMutation, args, user);

          // Check response
          expect(result.errors).to.not.exist;
          expect(result.data.uploadFile[0].parsingResult).to.containSubset({
            success: true,
            expense: {
              amount: { valueInCents: 65e2, currency: 'USD' },
              confidence: 100,
              date: '2023-08-01',
              description: 'Render invoice',
            },
          });
        });

        it('returns a sanitized error when Klippa fails', async () => {
          // Initialize nock
          sandbox.stub(axios, 'post').resolves({ err: { msg: 'Not allowed' }, status: 401 });

          // Trigger query
          const user = await fakeUser();
          const args = { files: [{ kind: 'EXPENSE_ITEM', file: getMockFileUpload(), parseDocument: true }] };
          const result = await graphqlQueryV2(uploadFileMutation, args, user);
          expect(result.errors).to.not.exist;
          expect(result.data.uploadFile[0].parsingResult).to.deep.eq({
            success: false,
            message: 'Could not parse document: Unexpected Error while calling the AI service',
            expense: null,
          });
        });

        // TODO(OCR): Add test
        // it('does not call Klippa if the file was already parsed', async () => {});
      });
    });
  });
});

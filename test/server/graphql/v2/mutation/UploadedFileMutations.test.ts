import { expect } from 'chai';
import config from 'config';
import gqlV2 from 'fake-tag';
import sinon from 'sinon';

import { SUPPORTED_FILE_KINDS } from '../../../../../server/constants/file-kind';
import * as ExpenseOCRLib from '../../../../../server/lib/ocr/index';
import { fakeUser } from '../../../../test-helpers/fake-data';
import { getMockFileUpload, graphqlQueryV2 } from '../../../../utils';

const uploadFileMutation = gqlV2/* GraphQL */ `
  mutation UploadFile($file: Upload!, $kind: UploadedFileKind!, $parseDocument: Boolean) {
    uploadFile(file: $file, kind: $kind, parseDocument: $parseDocument) {
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
        confidence
        expense {
          description
          incurredAt
          amount {
            valueInCents
            currency
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/mutation/UploadedFileMutations', () => {
  let sandbox;

  before(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('uploadFile', () => {
    it('must be logged in', async () => {
      const result = await graphqlQueryV2(uploadFileMutation, { kind: 'EXPENSE_ITEM', file: getMockFileUpload() });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('You need to be logged in to upload files');
    });

    it('simply uploads a file', async () => {
      const user = await fakeUser();
      const args = { kind: 'EXPENSE_ITEM', file: getMockFileUpload() };
      const result = await graphqlQueryV2(uploadFileMutation, args, user);
      expect(result.errors).to.not.exist;
      expect(result.data.uploadFile.parsingResult).to.be.null;
      expect(result.data.uploadFile.file.name).to.eq('camera.png');
      expect(result.data.uploadFile.file.type).to.eq('image/png');
      expect(result.data.uploadFile.file.size).to.eq(3628);
    });

    describe('with parseDocument', () => {
      it('can only use the option with EXPENSE_ITEM and EXPENSE_ATTACHED_FILE', async () => {
        const user = await fakeUser();
        const unsupportedKinds = SUPPORTED_FILE_KINDS.filter(
          k => k !== 'EXPENSE_ITEM' && k !== 'EXPENSE_ATTACHED_FILE',
        );
        for (const kind of unsupportedKinds) {
          const args = { file: getMockFileUpload(), kind, parseDocument: true };
          const result = await graphqlQueryV2(uploadFileMutation, args, user);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.eq(
            `parseDocument is only supported for EXPENSE_ITEM and EXPENSE_ATTACHED_FILE`,
          );
        }
      });

      it('does not crash but returns a proper error if parsing fails', async () => {
        // Mock OCR service with something that always fails
        sandbox.stub(ExpenseOCRLib, 'getExpenseOCRParser').returns({
          processUrl: () => {
            throw new Error('OCR parsing failed on purpose for test');
          },
          processImage: () => {
            throw new Error('OCR parsing failed on purpose for test');
          },
        });

        const user = await fakeUser();
        const args = { kind: 'EXPENSE_ITEM', file: getMockFileUpload(), parseDocument: true };
        const result = await graphqlQueryV2(uploadFileMutation, args, user);
        expect(result.errors).to.not.exist;
        expect(result.data.uploadFile.parsingResult).to.deep.eq({
          success: false,
          message: 'Could not parse document: OCR parsing failed on purpose for test',
          confidence: null,
          expense: null,
        });
      });

      // Since Klippa is not configured, the mock service is used by default
      describe('mocked service', () => {
        it('is used by default', async () => {
          const user = await fakeUser();
          const args = { kind: 'EXPENSE_ITEM', file: getMockFileUpload(), parseDocument: true };
          const result = await graphqlQueryV2(uploadFileMutation, args, user);
          expect(result.errors).to.not.exist;
          expect(result.data.uploadFile.parsingResult).to.not.be.null;
          expect(result.data.uploadFile.parsingResult).to.deep.eq({
            success: true,
            message: null,
            confidence: 100,
            expense: {
              description: 'Mock description',
              amount: { valueInCents: 100e2, currency: 'USD' },
              incurredAt: '2020-02-01',
            },
          });
        });

        it('is not used in production', async () => {
          sandbox.stub(config, 'env').value('production');
          const user = await fakeUser();
          const args = { kind: 'EXPENSE_ITEM', file: getMockFileUpload(), parseDocument: true };
          const result = await graphqlQueryV2(uploadFileMutation, args, user);
          expect(result.errors).to.not.exist;
          expect(result.data.uploadFile.parsingResult).to.deep.eq({
            success: false,
            message: 'OCR parsing is not available',
            confidence: null,
            expense: null,
          });
        });
      });

      // TODO Mock Klippa service and make sure we call its endpoints here
      // describe('using Klippa', () => {
      //   it('does not call Klippa if the file was already parsed', async () => {});
      //   it('calls Klippa with the file and formats the result', async () => {});
      // });
    });
  });
});

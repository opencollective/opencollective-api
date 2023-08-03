import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { FileUpload } from 'graphql-upload/Upload';
import { difference } from 'lodash';

import { FileKind } from '../../../constants/file-kind';
import { getExpenseOCRParser } from '../../../lib/ocr';
import models, { UploadedFile } from '../../../models';
import { checkRemoteUserCanUseExpenses } from '../../common/scope-check';
import { GraphQLUploadFileInput } from '../input/UploadFileInput';
import { GraphQLFileInfo } from '../interface/FileInfo';
import { GraphQLParseUploadedFileResult, ParseUploadedFileResult } from '../object/ParseUploadedFileResult';

const GraphQLUploadFileResult = new GraphQLObjectType({
  name: 'UploadFileResult',
  fields: () => ({
    file: {
      type: new GraphQLNonNull(GraphQLFileInfo),
    },
    parsingResult: {
      type: GraphQLParseUploadedFileResult,
    },
  }),
});

const uploadedFileMutations = {
  uploadFile: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLUploadFileResult))),
    args: {
      files: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLUploadFileInput))),
        description: 'The files to upload',
      },
    },
    async resolve(
      _: void,
      args: { files: Array<{ file: Promise<FileUpload>; kind?: FileKind; parseDocument: boolean }> },
      req: Express.Request,
    ): Promise<Array<{ file: UploadedFile; parsingResult?: ParseUploadedFileResult }>> {
      if (!req.remoteUser) {
        throw new Error('You need to be logged in to upload files');
      }

      // Limit on `kind` for this first release. If removing this, remember to update the part about `parseDocument`
      // as we don't want to support parsing for all kinds (e.g. Avatars).
      const allKinds = args.files.map(f => f.kind);
      const unSupportedKinds = difference(allKinds, ['EXPENSE_ITEM', 'EXPENSE_ATTACHED_FILE']);
      if (unSupportedKinds.length > 0) {
        throw new Error(`This mutation only supports the following kinds: EXPENSE_ITEM, EXPENSE_ATTACHED_FILE`);
      }

      // Since we're only supporting for expense at the moment, we check the expenses scope
      checkRemoteUserCanUseExpenses(req);

      // Sanity checks
      if (args.files.length === 0) {
        throw new Error('No file provided');
      } else if (args.files.length > 10) {
        throw new Error('You can only upload up to 10 files at once');
      }

      // Upload & parse files
      const useOCR = args.files.some(r => r.parseDocument);
      const parser = useOCR ? getExpenseOCRParser() : null;
      return Promise.all(
        args.files.map(async ({ file, kind, parseDocument }) => {
          const uploadedFile = await models.UploadedFile.uploadGraphQl(await file, kind, req.remoteUser);
          let parsingResult;
          if (parseDocument) {
            if (parser) {
              try {
                const [result] = await parser.processUrl(uploadedFile.url);
                parsingResult = {
                  success: true,
                  confidence: result.confidence,
                  expense: {
                    description: result.description,
                    amount: result.amount,
                    incurredAt: result.date,
                  },
                };
              } catch (e) {
                parsingResult = { success: false, message: `Could not parse document: ${e.message}` };
              }
            } else {
              parsingResult = { success: false, message: 'OCR parsing is not available' };
            }
          }

          return { file: uploadedFile, parsingResult: parsingResult };
        }),
      );
    },
  },
};

export default uploadedFileMutations;

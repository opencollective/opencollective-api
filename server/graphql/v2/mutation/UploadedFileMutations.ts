import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import GraphQLUpload from 'graphql-upload/GraphQLUpload.js';
import { FileUpload } from 'graphql-upload/Upload';

import { FileKind } from '../../../constants/file-kind';
import { getExpenseOCRParser } from '../../../lib/ocr';
import models, { UploadedFile } from '../../../models';
import { checkRemoteUserCanUseExpenses } from '../../common/scope-check';
import { GraphQLUploadedFileKind } from '../enum/UploadedFileKind';
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
    type: new GraphQLNonNull(GraphQLUploadFileResult),
    args: {
      file: {
        type: new GraphQLNonNull(GraphQLUpload),
        description: 'The file to upload',
      },
      kind: {
        type: new GraphQLNonNull(GraphQLUploadedFileKind),
        description: 'The kind of file to uploaded',
      },
      parseDocument: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description:
          'Whether to run OCR on the document. Note that this feature is only available to selected accounts.',
        defaultValue: false,
      },
    },
    async resolve(
      _: void,
      args: { file: Promise<FileUpload>; kind?: FileKind; parseDocument: boolean },
      req: Express.Request,
    ): Promise<{ file: UploadedFile; parsingResult?: ParseUploadedFileResult }> {
      if (!req.remoteUser) {
        throw new Error('You need to be logged in to upload files');
      } else if (!['EXPENSE_ITEM', 'EXPENSE_ATTACHED_FILE'].includes(args.kind)) {
        throw new Error(`parseDocument is only supported for EXPENSE_ITEM and EXPENSE_ATTACHED_FILE`);
      }

      // Since we're only supporting for expense at the moment, we check the expenses scope
      checkRemoteUserCanUseExpenses(req);

      // Upload file to S3
      const uploadedFile = await models.UploadedFile.uploadGraphQl(await args.file, args.kind, req.remoteUser);

      // Parse document
      let parsingResult: ParseUploadedFileResult | undefined;
      if (args.parseDocument) {
        const parser = getExpenseOCRParser();
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

      return { file: uploadedFile, parsingResult };
    },
  },
};

export default uploadedFileMutations;

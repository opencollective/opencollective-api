import { GraphQLFieldConfig, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { FileUpload } from 'graphql-upload/Upload';
import { difference } from 'lodash';

import { FileKind } from '../../../constants/file-kind';
import { getExpenseOCRParser, runOCRForExpenseFile, userCanUseOCR } from '../../../lib/ocr';
import models, { UploadedFile } from '../../../models';
import { checkRemoteUserCanUseExpenses } from '../../common/scope-check';
import { RateLimitExceeded } from '../../errors';
import { GraphQLOCRParsingOptionsInputType } from '../input/OCRParsingOptionsInput';
import { GraphQLUploadFileInput } from '../input/UploadFileInput';
import { GraphQLFileInfo } from '../interface/FileInfo';
import { GraphQLParseUploadedFileResult, ParseUploadedFileResult } from '../object/ParseUploadedFileResult';

type UploadFileResult = { file: UploadedFile; parsingResult?: ParseUploadedFileResult };

const GraphQLUploadFileResult = new GraphQLObjectType({
  name: 'UploadFileResult',
  fields: (): Record<keyof UploadFileResult, GraphQLFieldConfig<void, Express.Request>> => ({
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
      args: {
        files: Array<{
          file: Promise<FileUpload>;
          kind?: FileKind;
          parseDocument: boolean;
          parsingOptions: GraphQLOCRParsingOptionsInputType;
        }>;
      },
      req: Express.Request,
    ): Promise<Array<UploadFileResult>> {
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
      } else if (args.files.length > 15) {
        throw new Error('You can only upload up to 15 files at once');
      }

      // Rate limiting: max 100 files/user/hour
      const rateLimit = models.UploadedFile.getUploadRateLimiter(req.remoteUser);
      if (!(await rateLimit.registerCall(args.files.length))) {
        throw new RateLimitExceeded(
          'You have reached the limit for uploading files. Please try again in an hour or contact support.',
        );
      }

      // Upload & parse files
      const canUseOCR = userCanUseOCR(req.remoteUser);
      const useOCR = canUseOCR && args.files.some(r => r.parseDocument);
      const parser = useOCR ? getExpenseOCRParser(req.remoteUser) : null;
      return Promise.all(
        args.files.map(async ({ file, kind, parseDocument, parsingOptions }) => {
          const uploadStart = performance.now();
          const result: UploadFileResult = { file: null, parsingResult: null };
          result.file = await models.UploadedFile.uploadGraphQl(await file, kind, req.remoteUser);
          const uploadDuration = (performance.now() - uploadStart) / 1000.0;
          const timeLeftForParsing = 25e3 - uploadDuration; // GraphQL queries timeout after 25s
          if (parseDocument && timeLeftForParsing > 2e3) {
            result.parsingResult = await runOCRForExpenseFile(parser, result.file, {
              ...parsingOptions,
              timeoutInMs: timeLeftForParsing,
            });
          }

          return result;
        }),
      );
    },
  },
};

export default uploadedFileMutations;

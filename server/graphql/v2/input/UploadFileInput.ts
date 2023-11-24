import { GraphQLBoolean, GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import GraphQLUpload from 'graphql-upload/GraphQLUpload.js';

import { GraphQLUploadedFileKind } from '../enum';

import { GraphQLOCRParsingOptionsInput } from './OCRParsingOptionsInput';

export const GraphQLUploadFileInput = new GraphQLInputObjectType({
  name: 'UploadFileInput',
  fields: () => ({
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
      description: 'Whether to run OCR on the document. Note that this feature is only available to selected accounts.',
      defaultValue: false,
    },
    parsingOptions: {
      type: GraphQLOCRParsingOptionsInput,
      description: 'If `parseDocument` is true, you can use this field to pass options to the OCR parser.',
      defaultValue: null,
    },
  }),
});

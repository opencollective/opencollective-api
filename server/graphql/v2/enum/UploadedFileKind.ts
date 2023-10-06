import { GraphQLEnumType } from 'graphql';

import { SUPPORTED_FILE_KINDS } from '../../../constants/file-kind';

export const GraphQLUploadedFileKind = new GraphQLEnumType({
  name: 'UploadedFileKind',
  description: 'The kind of file that was uploaded',
  values: SUPPORTED_FILE_KINDS.reduce((acc, value) => {
    return {
      ...acc,
      [value]: { value },
    };
  }, {}),
});

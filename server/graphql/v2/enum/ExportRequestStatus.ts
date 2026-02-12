import { GraphQLEnumType } from 'graphql';

import { ExportRequestStatus } from '../../../models/ExportRequest';

export const GraphQLExportRequestStatus = new GraphQLEnumType({
  name: 'ExportRequestStatus',
  description: 'The status of an export request',
  values: Object.keys(ExportRequestStatus).reduce((acc, key) => {
    return {
      ...acc,
      [key]: {
        value: ExportRequestStatus[key],
      },
    };
  }, {}),
});

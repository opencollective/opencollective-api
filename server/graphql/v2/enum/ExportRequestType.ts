import { GraphQLEnumType } from 'graphql';

import { ExportRequestTypes } from '../../../models/ExportRequest';

export const GraphQLExportRequestType = new GraphQLEnumType({
  name: 'ExportRequestType',
  description: 'The type of export request',
  values: Object.keys(ExportRequestTypes).reduce(
    (acc, key) => ({
      ...acc,
      [key]: {
        value: ExportRequestTypes[key],
        description: `Export request for ${key.toLowerCase().replace('_', ' ')}`,
      },
    }),
    {},
  ),
});

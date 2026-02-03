import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { GraphQLExportRequestType } from '../enum/ExportRequestType';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput';

export const GraphQLExportRequestCreateInput = new GraphQLInputObjectType({
  name: 'ExportRequestCreateInput',
  description: 'Input type for creating an ExportRequest',
  fields: () => ({
    account: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'The account to create the export request for',
    },
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'A name for this export request',
    },
    type: {
      type: new GraphQLNonNull(GraphQLExportRequestType),
      description: 'The type of export to create',
    },
    parameters: {
      type: GraphQLJSON,
      description: 'Optional parameters for the export request',
    },
  }),
});

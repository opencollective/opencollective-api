import { GraphQLBoolean, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { AccountReferenceInput } from './AccountReferenceInput';

export const UpdateCreateInput = new GraphQLInputObjectType({
  name: 'UpdateCreateInput',
  description: 'Input type for UpdateType',
  fields: () => ({
    title: { type: new GraphQLNonNull(GraphQLString) },
    isPrivate: { type: GraphQLBoolean },
    isChangelog: { type: GraphQLBoolean },
    makePublicOn: { type: GraphQLDateTime },
    html: { type: new GraphQLNonNull(GraphQLString) },
    fromAccount: { type: AccountReferenceInput },
    account: { type: new GraphQLNonNull(AccountReferenceInput) },
  }),
});

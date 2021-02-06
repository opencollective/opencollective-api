import { GraphQLBoolean, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import ISODateTime from '../scalar/ISODateTime';

import { AccountReferenceInput } from './AccountReferenceInput';

export const UpdateUpdateInput = new GraphQLInputObjectType({
  name: 'UpdateUpdateInput',
  description: 'Input type for UpdateType',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: GraphQLString },
    title: { type: GraphQLString },
    isPrivate: { type: GraphQLBoolean },
    makePublicOn: { type: ISODateTime },
    html: { type: GraphQLString },
    fromAccount: { type: AccountReferenceInput },
  }),
});

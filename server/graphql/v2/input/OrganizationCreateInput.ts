import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { AccountImagesInputFields } from './AccountCreateInputImageFields';

export const GraphQLOrganizationCreateInput = new GraphQLInputObjectType({
  name: 'OrganizationCreateInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    legalName: { type: GraphQLString },
    slug: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    website: { type: GraphQLString, deprecationReason: '2024-11-12: Please use socialLinks' },
    settings: { type: GraphQLJSON },
    ...AccountImagesInputFields,
  }),
});

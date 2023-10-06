import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLContributor } from '../object/Contributor';

export const GraphQLContributorCollection = new GraphQLObjectType({
  name: 'ContributorCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Contributor"',
  fields: () => ({
    ...CollectionFields,
    nodes: {
      type: new GraphQLList(GraphQLContributor),
    },
  }),
});

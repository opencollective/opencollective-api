import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import { Contributor } from '../object/Contributor';

const ContributorCollection = new GraphQLObjectType({
  name: 'ContributorCollection',
  interfaces: [Collection],
  description: 'A collection of "Contributor"',
  fields: {
    ...CollectionFields,
    nodes: {
      type: new GraphQLList(Contributor),
    },
  },
});

export { ContributorCollection };

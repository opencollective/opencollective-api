import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import { Activity } from '../object/Activity';

export const ActivityCollection = new GraphQLObjectType({
  name: 'ActivityCollection',
  interfaces: [Collection],
  description: 'A collection of "Activities"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(new GraphQLNonNull(Activity)),
      },
    };
  },
});

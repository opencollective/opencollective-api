import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Host } from '../object/Host';
import { Collection, CollectionFields } from '../interface/Collection';

const HostCollection = new GraphQLObjectType({
  name: 'HostCollection',
  interfaces: [Collection],
  description: 'A collection of "Hosts"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(Host),
      },
    };
  },
});

export { HostCollection };

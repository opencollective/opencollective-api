import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import { Host } from '../object/Host';

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

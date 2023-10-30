import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLVendor } from '../object/Vendor';

export const GraphQLVendorCollection = new GraphQLObjectType({
  name: 'VendorCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of Vendors',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLVendor)),
      },
    };
  },
});

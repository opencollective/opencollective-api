import { GraphQLInt, GraphQLInterfaceType } from 'graphql';

/** All the fields Collection interface implementers have to implemented. */
const CollectionFields = {
  offset: {
    type: GraphQLInt,
  },
  limit: {
    type: GraphQLInt,
  },
  totalCount: {
    type: GraphQLInt,
  },
};

/**
 * Interface intended to be implemented by every type that returns a
 * collection of types. The implementing type will look like:
 * {
 *  offset: Int,
 *  limit: Int,
 *  totalCount: Int,
 *  nodes: [<Type>]
 * }
 * By convention the collection of types is called nodes.
 */
const Collection = new GraphQLInterfaceType({
  name: 'Collection',
  description: 'Collection interface shared by all collection types',
  fields: CollectionFields,
});

/**
 * Types to use as arguments for fields that return types
 * that implement the Collection interface.
 */
const CollectionArgs = {
  limit: {
    type: GraphQLInt,
    description: 'The number of results to fetch (default 10, max 1000)',
    defaultValue: 10,
  },
  offset: {
    type: GraphQLInt,
    description: 'The offset to use to fetch',
    defaultValue: 0,
  },
};

export interface CollectionReturnType {
  nodes: object[];
  totalCount: number;
  limit: number;
  offset: number;
}

export { Collection, CollectionFields, CollectionArgs };

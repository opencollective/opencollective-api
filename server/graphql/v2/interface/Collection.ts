import { GraphQLInt, GraphQLInterfaceType, GraphQLNonNull } from 'graphql';

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
const GraphQLCollection = new GraphQLInterfaceType({
  name: 'Collection',
  description: 'Collection interface shared by all collection types',
  fields: () => CollectionFields,
});

/**
 * Types to use as arguments for fields that return types
 * that implement the Collection interface.
 */
const CollectionArgs = {
  limit: {
    type: new GraphQLNonNull(GraphQLInt),
    description: 'The number of results to fetch (default 10, max 1000)',
    defaultValue: 10,
  },
  offset: {
    type: new GraphQLNonNull(GraphQLInt),
    description: 'The offset to use to fetch',
    defaultValue: 0,
  },
};

/**
 * A helper to return `CollectionArgs` with custom defaults
 */
export const getCollectionArgs = ({ limit = 10, offset = 0 }) => ({
  limit: {
    ...CollectionArgs.limit,
    defaultValue: limit || CollectionArgs.limit.defaultValue,
  },
  offset: {
    ...CollectionArgs.offset,
    defaultValue: offset || CollectionArgs.offset.defaultValue,
  },
});

export interface CollectionReturnType<T = unknown> {
  nodes: T[] | Promise<T[]> | (() => Promise<T[]>);
  totalCount: number | Promise<number> | (() => Promise<number>);
  limit: number;
  offset: number;
}

export type CollectionArgsType = {
  limit?: number;
  offset?: number;
};

export { GraphQLCollection, CollectionFields, CollectionArgs };

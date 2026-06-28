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

export const COLLECTION_DEFAULT_LIMIT = 10;
export const COLLECTION_DEFAULT_OFFSET = 0;

export const collectionLimitArg = (defaultLimit = COLLECTION_DEFAULT_LIMIT) => ({
  type: new GraphQLNonNull(GraphQLInt),
  description: 'The number of results to fetch (default 10, max 1000)',
  default: { value: defaultLimit },
});

export const collectionOffsetArg = (defaultOffset = COLLECTION_DEFAULT_OFFSET) => ({
  type: new GraphQLNonNull(GraphQLInt),
  description: 'The offset to use to fetch',
  default: { value: defaultOffset },
});

/**
 * Types to use as arguments for fields that return types
 * that implement the Collection interface.
 */
const CollectionArgs = {
  limit: collectionLimitArg(),
  offset: collectionOffsetArg(),
};

/**
 * A helper to return `CollectionArgs` with custom defaults
 */
export const getCollectionArgs = ({ limit = COLLECTION_DEFAULT_LIMIT, offset = COLLECTION_DEFAULT_OFFSET } = {}) => ({
  limit: collectionLimitArg(limit ?? COLLECTION_DEFAULT_LIMIT),
  offset: collectionOffsetArg(offset ?? COLLECTION_DEFAULT_OFFSET),
});

export interface CollectionReturnType<T = unknown> {
  nodes: T[] | Promise<T[]> | (() => Promise<T[]>);
  totalCount: number | Promise<number> | (() => Promise<number>);
  limit: number;
  offset: number;
}

export { GraphQLCollection, CollectionFields, CollectionArgs };

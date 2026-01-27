import { GraphQLInt, GraphQLInterfaceType, GraphQLNonNull } from 'graphql';
import { isNil } from 'lodash';

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
    defaultValue: limit ?? CollectionArgs.limit.defaultValue,
  },
  offset: {
    ...CollectionArgs.offset,
    defaultValue: offset ?? CollectionArgs.offset.defaultValue,
  },
});

export interface CollectionReturnType<T = unknown> {
  nodes: T[] | Promise<T[]> | (() => Promise<T[]>);
  totalCount: number | Promise<number> | (() => Promise<number>);
  limit: number;
  offset: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Validates and normalizes pagination arguments for collection queries.
 * - Defaults limit to `defaultLimit` (100) if nil or negative
 * - Defaults offset to 0 if nil or negative
 * - Throws error if limit exceeds `maxLimit` (1000) unless user is root
 *
 * @returns Validated { offset, limit } values
 */
export const getValidatedPaginationArgs = (
  args: { limit?: number; offset?: number },
  req?: { remoteUser?: { isRoot?: () => boolean } },
  { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT }: { defaultLimit?: number; maxLimit?: number } = {},
): { offset: number; limit: number } => {
  const limit = isNil(args.limit) || args.limit < 0 ? defaultLimit : args.limit;
  const offset = isNil(args.offset) || args.offset < 0 ? 0 : args.offset;

  if (limit > maxLimit && !req?.remoteUser?.isRoot?.()) {
    throw new Error(
      `Cannot fetch more than ${maxLimit.toLocaleString()} results at the same time, please adjust the limit`,
    );
  }

  return { offset, limit };
};

export { GraphQLCollection, CollectionFields, CollectionArgs };

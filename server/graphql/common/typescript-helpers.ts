import type {
  GraphQLArgumentConfig,
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLString,
} from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { GraphQLAccountType, GraphQLAccountTypeKeys } from '../v2/enum/AccountType';

type GraphQLTypeForPrimitiveType<T> =
  // Custom enums
  T extends GraphQLAccountTypeKeys
    ? typeof GraphQLAccountType
    : // Primitive types
      T extends string
      ? typeof GraphQLString | typeof GraphQLNonEmptyString
      : T extends boolean
        ? typeof GraphQLBoolean
        : T extends number
          ? typeof GraphQLInt | typeof GraphQLFloat
          : // List
            T extends (infer U)[]
            ? GraphQLList<GraphQLTypeForPrimitiveType<U>>
            : // Unsupported types
              never;

// type GraphQLTypeForPrimitiveTypeWithNull<T> = T extends string

/**
 * Takes a fields map like `{ myField: number }` and makes it a GraphQLFieldConfigArgumentMap type
};
 */
export type FieldsToGraphQLFieldConfigArgumentMap<T> = {
  [K in keyof T]: GraphQLArgumentConfig & { type: GraphQLTypeForPrimitiveType<T[K]> };
};

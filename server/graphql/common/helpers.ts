import {
  GraphQLArgumentConfig,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLType,
} from 'graphql';

export type GraphQLArguments<T extends Record<string, GraphQLArgumentConfig>> = {
  [ArgName in keyof T]: GraphQLTypeValue<T[ArgName]['type']>;
};

type GraphQLTypeValue<T extends GraphQLType> =
  T extends GraphQLNonNull<infer V>
    ? GraphQLTypeValue<V>
    : T extends GraphQLScalarType
      ? ReturnType<T['parseValue']>
      : T extends GraphQLEnumType
        ? string
        : T extends GraphQLObjectType
          ? Record<string, unknown>
          : T extends GraphQLInputObjectType
            ? Record<string, unknown>
            : T extends GraphQLList<infer V>
              ? GraphQLTypeValue<V>[]
              : unknown;

import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';
import { isNaN, isNil } from 'lodash';

const processValue = value => {
  if (isNil(value) || isNaN(value)) {
    throw new GraphQLError(`Value is not a number: ${value}`);
  }

  const parsedValue = parseFloat(value);
  if (!Number.isFinite(parsedValue)) {
    throw new GraphQLError(`Value is not a finite number: ${value}`);
  }

  if (value < 0) {
    throw new GraphQLError(`Value is not a positive number: ${value}`);
  } else if (value > 100) {
    throw new GraphQLError(`Value is not less than or equal to 100: ${value}`);
  } else {
    return parsedValue;
  }
};

export const GraphQLStrictPercentage = new GraphQLScalarType({
  name: 'StrictPercentage',
  description: 'A positive float value between 0 and 100',
  serialize(value) {
    return processValue(value);
  },
  parseValue(value) {
    return processValue(value);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.FLOAT && ast.kind !== Kind.INT) {
      throw new GraphQLError(
        `Can only validate percentage as non-negative floating point numbers but got a: ${ast.kind}`,
        { nodes: ast },
      );
    }

    return processValue(ast.value);
  },
  extensions: {
    codegenScalarType: 'number',
    jsonSchema: {
      title: 'StrictPercentage',
      type: 'number',
      minimum: 0,
      maximum: 100,
    },
  },
});

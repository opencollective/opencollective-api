import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';
import { isEmail } from 'validator/es/index.js';

const validateAndFormat = (value: unknown) => {
  if (typeof value !== 'string') {
    throw new TypeError(`Value is not string: ${value}`);
  }

  if (!isEmail(value)) {
    throw new TypeError(`Value is not a valid email address: ${value}`);
  }

  return value.trim().toLowerCase();
};

/**
 * A field whose value conforms to the standard internet email address format as specified in RFC822: https://www.w3.org/Protocols/rfc822/.
 * Inspired by https://github.com/Urigo/graphql-scalars/blob/master/src/scalars/EmailAddress.ts
 */
const GraphQLEmailAddress = new GraphQLScalarType({
  name: 'EmailAddress',
  description:
    'A field whose value conforms to the standard internet email address format as specified in RFC822: https://www.w3.org/Protocols/rfc822/.',

  serialize: validateAndFormat,
  parseValue: validateAndFormat,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError(`Can only validate strings as email addresses but got a: ${ast.kind}`);
    }

    return validateAndFormat(ast.value);
  },
});

export default GraphQLEmailAddress;

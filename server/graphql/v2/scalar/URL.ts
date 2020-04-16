import { URL } from 'url';

import { GraphQLScalarType } from 'graphql';

import { ValidationFailed } from '../../errors';

export default new GraphQLScalarType({
  name: 'URL',
  description: "A field whose value conforms to the standard URL format as specified in RFC3986: https://www.ietf.org/rfc/rfc3986.txt.",
  parseValue(value: string): string {
    try {
      return new URL(value).toString()
    } catch {
      throw new ValidationFailed(`Not a valid URL: ${value}`);
    }
  },
  serialize(value: string): string {
    return value;
  },
});

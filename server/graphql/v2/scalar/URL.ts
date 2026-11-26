import { GraphQLScalarType } from 'graphql';

import { parseNavigableHttpUrl } from '../../../lib/url-validation';

const GraphQLURL = new GraphQLScalarType({
  name: 'URL',
  description:
    'A field whose value is an HTTP or HTTPS URL as specified in RFC3986: https://www.ietf.org/rfc/rfc3986.txt.',
  parseValue(value: string): string {
    return parseNavigableHttpUrl(value).toString();
  },
  serialize(value: string): string {
    return value;
  },
});

export default GraphQLURL;

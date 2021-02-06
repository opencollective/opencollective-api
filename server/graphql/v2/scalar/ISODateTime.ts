import { GraphQLScalarType, Kind, ValueNode } from 'graphql';

export default new GraphQLScalarType({
  name: 'ISODateTime',
  description: 'ISO-8601 date',
  parseValue(value: number): Date {
    return new Date(value); // value from the client
  },
  serialize(value: Date): string {
    return value.toString(); // value sent to the client
  },
  parseLiteral(ast: ValueNode): Date {
    if (ast.kind === Kind.INT) {
      return new Date(+ast.value);
    } else if (ast.kind === Kind.STRING) {
      return new Date(ast.value);
    }
  },
});

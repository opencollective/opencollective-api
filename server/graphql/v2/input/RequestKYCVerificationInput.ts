import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

const GraphQLRequestManualKYCVerificationInput = new GraphQLInputObjectType({
  name: 'RequestManualKYCVerificationInput',
  fields: () => ({
    legalName: {
      type: new GraphQLNonNull(GraphQLString),
    },
    legalAddress: {
      type: new GraphQLNonNull(GraphQLString),
    },
    notes: {
      type: GraphQLString,
    },
  }),
});

const GraphQLRequestKYCVerificationInput = new GraphQLInputObjectType({
  name: 'RequestKYCVerificationInput',
  isOneOf: true,
  fields: () => ({
    manual: {
      type: GraphQLRequestManualKYCVerificationInput,
    },
  }),
});

export { GraphQLRequestKYCVerificationInput };

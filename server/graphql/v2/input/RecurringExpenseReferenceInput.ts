import { GraphQLInputObjectType, GraphQLString } from 'graphql';

const RecurringExpenseReferenceInput = new GraphQLInputObjectType({
  name: 'RecurringExpenseReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the recurring expense (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
  }),
});

export { RecurringExpenseReferenceInput };

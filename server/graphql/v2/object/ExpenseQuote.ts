import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLAmount } from './Amount';

const GraphQLExpenseQuoteNotice = new GraphQLObjectType({
  name: 'ExpenseQuoteNotice',
  description: 'Fields for an expense quote notice',
  fields: () => ({
    type: { type: new GraphQLNonNull(GraphQLString) },
    text: { type: new GraphQLNonNull(GraphQLString) },
    code: { type: new GraphQLNonNull(GraphQLString) },
    link: { type: new GraphQLNonNull(GraphQLString) },
  }),
});

const GraphQLExpenseQuote = new GraphQLObjectType({
  name: 'ExpenseQuote',
  description: 'Fields for an expense quote',
  fields: () => ({
    sourceAmount: {
      type: new GraphQLNonNull(GraphQLAmount),
      description: 'Amount of this item',
    },
    paymentProcessorFeeAmount: {
      type: new GraphQLNonNull(GraphQLAmount),
      description: 'Amount of payment processor fee',
    },
    estimatedDeliveryAt: {
      type: GraphQLDateTime,
      description: 'The date on which the item was created',
    },
    notices: {
      type: new GraphQLList(GraphQLExpenseQuoteNotice),
      description: 'Notices related to this quote',
    },
  }),
});

export default GraphQLExpenseQuote;

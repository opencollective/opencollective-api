import { GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLAmount } from './Amount';

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
  }),
});

export default GraphQLExpenseQuote;

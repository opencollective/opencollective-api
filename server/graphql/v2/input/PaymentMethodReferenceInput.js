import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import PaymentMethod from '../../../models/PaymentMethod';
import { NotFound } from '../../errors';
import { idDecode } from '../identifiers';

export const GraphQLPaymentMethodReferenceInput = new GraphQLInputObjectType({
  name: 'PaymentMethodReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The id assigned to the payment method',
    },
  }),
});

/**
 * Retrieves a payment method
 *
 * @param {object} input - id of the payment method
 */
export const fetchPaymentMethodWithReference = async (input, { sequelizeOpts } = {}) => {
  // Load payment by ID using GQL loaders if we're not using a transaction & loaders are available
  const loadPaymentById = id => {
    return PaymentMethod.findByPk(id, sequelizeOpts);
  };

  let paymentMethod;
  if (input.id) {
    const id = idDecode(input.id, 'paymentMethod');
    paymentMethod = await loadPaymentById(id);
  } else {
    throw new Error('Please provide an id');
  }
  if (!paymentMethod) {
    throw new NotFound('Payment Method Not Found');
  }
  return paymentMethod;
};

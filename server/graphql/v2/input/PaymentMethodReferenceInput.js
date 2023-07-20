import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import models from '../../../models/index.js';
import { NotFound } from '../../errors.js';
import { idDecode } from '../identifiers.js';

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
    return models.PaymentMethod.findByPk(id, sequelizeOpts);
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

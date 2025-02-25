import assert from 'assert';

import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

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
    const id = idDecode(input.id, IDENTIFIER_TYPES.PAYMENT_METHOD);
    paymentMethod = await loadPaymentById(id);
  } else {
    throw new Error('Please provide an id');
  }
  if (!paymentMethod) {
    throw new NotFound('Payment Method Not Found');
  }
  return paymentMethod;
};

export const fetchPaymentMethodWithReferences = async (inputs, { sequelizeOpts } = {}) => {
  inputs = Array.isArray(inputs) ? inputs : [inputs];
  if (inputs.length > 200) {
    throw new Error('You can only fetch up to 200 accounts at once');
  } else if (inputs.length === 0) {
    return [];
  }

  const ids = inputs.map(input => idDecode(input.id, IDENTIFIER_TYPES.PAYMENT_METHOD));
  assert(inputs.length === ids.length, new Error('Invalid id provided'));

  const paymentMethods = await models.PaymentMethod.findAll({
    where: { id: ids },
    ...sequelizeOpts,
  });

  return paymentMethods;
};

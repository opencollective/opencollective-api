import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode } from '../identifiers';

export const PaymentMethodReferenceInput = new GraphQLInputObjectType({
  name: 'PaymentMethodReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The encrypted id assigned to the payment method',
    },
  }),
});

/**
 * Retrieves a payment method
 *
 * @param {string|number} input - id of the payment method
 * @param {object} params
 *    - dbTransaction: An SQL transaction to run the query. Will skip `loaders`
 *    - lock: If true and `dbTransaction` is set, the row will be locked
 */
export const fetchPaymentMethodWithReference = async (
  input,
  { loaders = null, throwIfMissing = false, dbTransaction = undefined, lock = false } = {},
) => {
  // Load payment by ID using GQL loaders if we're not using a transaction & loaders are available
  const loadPaymentById = id => {
    if (!loaders || dbTransaction) {
      return models.PaymentMethod.findByPk(id, { transaction: dbTransaction, lock });
    } else {
      return loaders.PaymentMethod.byId.load(id);
    }
  };

  let paymentMethod;
  if (input.id) {
    const id = idDecode(input.id, 'paymentMethod');
    paymentMethod = await loadPaymentById(id);
  } else {
    throw new Error('Please provide an id');
  }
  if (!paymentMethod && throwIfMissing) {
    throw new NotFound('Payment Method Not Found');
  }
  return paymentMethod;
};

import { GraphQLInputObjectType, GraphQLString } from 'graphql';
import { partition, uniq } from 'lodash';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import models, { Op } from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLPaymentMethodReferenceInput = new GraphQLInputObjectType({
  name: 'PaymentMethodReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: `The id assigned to the payment method (ie: ${EntityShortIdPrefix.PaymentMethod}_xxxxxxxx)`,
    },
  }),
});

/**
 * Retrieves a payment method
 *
 * @param {object} input - id of the payment method
 */
export const fetchPaymentMethodWithReference = async (input, { loaders = null, sequelizeOpts } = {}) => {
  // Load payment by ID using GQL loaders if we're not using a transaction & loaders are available
  const loadPaymentById = id => {
    return models.PaymentMethod.findByPk(id, sequelizeOpts);
  };

  let paymentMethod;
  if (isEntityPublicId(input.id, EntityShortIdPrefix.PaymentMethod)) {
    paymentMethod = loaders
      ? await loaders.PaymentMethod.byPublicId.load(input.id)
      : await models.PaymentMethod.findOne({ where: { publicId: input.id }, ...sequelizeOpts });
  } else if (input.id) {
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

  const [inputsWithPublicId, inputsWithoutPublicId] = partition(inputs, input =>
    isEntityPublicId(input.id, EntityShortIdPrefix.PaymentMethod),
  );

  const ids = uniq(inputsWithoutPublicId.map(input => idDecode(input.id, IDENTIFIER_TYPES.PAYMENT_METHOD)));
  const publicIds = uniq(inputsWithPublicId.map(input => input.id));

  const where = {};
  if (ids.length > 0 && publicIds.length > 0) {
    where[Op.or] = [{ id: ids }, { publicId: publicIds }];
  } else if (ids.length > 0) {
    where.id = ids;
  } else if (publicIds.length > 0) {
    where.publicId = publicIds;
  }

  const paymentMethods = await models.PaymentMethod.findAll({
    where: { id: ids },
    ...sequelizeOpts,
  });

  return paymentMethods;
};

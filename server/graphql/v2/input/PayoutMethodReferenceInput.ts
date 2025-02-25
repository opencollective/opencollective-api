import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import models, { PayoutMethod } from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLPayoutMethodReferenceInput = new GraphQLInputObjectType({
  name: 'PayoutMethodReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The id assigned to the payout method',
    },
  }),
});

/**
 * Retrieves a payout method
 *
 * @param {object} input - id of the payout method
 */
export const fetchPayoutMethodWithReference = async (
  input,
  {
    sequelizeOpts,
    loaders,
  }: { sequelizeOpts?: Parameters<typeof models.PayoutMethod.findByPk>[1]; loaders?: Express.Request['loaders'] } = {},
) => {
  // Load payout by ID using GQL loaders if we're not using a transaction & loaders are available
  const loadPayoutById = id =>
    loaders ? loaders.PayoutMethod.byId.load(id) : models.PayoutMethod.findByPk(id, sequelizeOpts);

  let payoutMethod: PayoutMethod;
  if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.PAYOUT_METHOD);
    payoutMethod = await loadPayoutById(id);
  } else {
    throw new Error('Please provide an id');
  }
  if (!payoutMethod) {
    throw new NotFound('Payout Method Not Found');
  }
  return payoutMethod;
};

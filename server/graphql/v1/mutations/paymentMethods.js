import { pick } from 'lodash';

import logger from '../../../lib/logger';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models, { Op } from '../../../models';
import { setupCreditCard } from '../../../paymentProviders/stripe/creditcard';
import { Forbidden } from '../../errors';

/** Create a Payment Method through a collective(organization or user)
 *
 * @param {Object} args contains the parameters to create the new payment method
 * @param {Object} remoteUser logged in user
 */
export async function createPaymentMethod(args, remoteUser) {
  if (!remoteUser) {
    throw new Error('You need to be logged in to create this payment method.');
  }
  if (!remoteUser.isAdmin(args.CollectiveId)) {
    throw new Error('You must be an admin of this Collective.');
  }
  if (!args.type) {
    throw new Error('Missing PaymentMethod type');
  }
  if (args.service === 'stripe' && args.type === 'creditcard') {
    return createStripeCreditCard(args, remoteUser);
  } else {
    throw new Error('Payment method type not supported');
  }
}

/** Add a stripe credit card to given collective */
async function createStripeCreditCard(args, remoteUser) {
  const collective = await models.Collective.findByPk(args.CollectiveId);
  if (!collective) {
    throw Error('This collective does not exists');
  }

  const paymentMethodData = {
    ...args,
    type: 'creditcard',
    service: 'stripe',
    currency: args.currency || collective.currency,
    saved: true,
  };

  let paymentMethod = await models.PaymentMethod.create(paymentMethodData);

  try {
    paymentMethod = await setupCreditCard(paymentMethod, {
      collective,
      user: remoteUser,
    });
  } catch (error) {
    if (!error.stripeResponse) {
      throw error;
    }

    paymentMethod.stripeError = {
      message: error.message,
      response: error.stripeResponse,
    };

    return paymentMethod;
  }

  paymentMethod = await paymentMethod.update({ primary: true });

  // We must unset the `primary` flag on all other payment methods
  await models.PaymentMethod.update(
    { primary: false },
    {
      where: {
        id: { [Op.ne]: paymentMethod.id },
        CollectiveId: collective.id,
        archivedAt: { [Op.eq]: null },
      },
    },
  );

  return paymentMethod;
}

/** Archive the given payment method */
const PaymentMethodPermissionError = new Forbidden(
  "This payment method does not exist or you don't have the permission to edit it.",
);

/** Update payment method with given args */
export async function replaceCreditCard(args, req) {
  logger.info(`Replacing Credit Card: ${args.id} ${req.remoteUser?.id}`);
  const oldPaymentMethod = await models.PaymentMethod.findByPk(args.id, {
    include: [{ model: models.Collective, required: true }],
  });
  if (!oldPaymentMethod || !req.remoteUser || !req.remoteUser.isAdminOfCollective(oldPaymentMethod.Collective)) {
    throw PaymentMethodPermissionError;
  }

  await twoFactorAuthLib.enforceForAccount(req, oldPaymentMethod.Collective, { onlyAskOnLogin: true });

  const createArgs = {
    ...pick(args, ['CollectiveId', 'name', 'token', 'data']),
    service: 'stripe',
    type: 'creditcard',
  };

  const newPaymentMethod = await createPaymentMethod(createArgs, req.remoteUser);

  // Update orders (using Sequelize)
  // first arg in new thing, second arg is old thing it's replacing
  await models.Order.update(
    { PaymentMethodId: newPaymentMethod.id },
    {
      where: {
        PaymentMethodId: oldPaymentMethod.id,
        status: 'ACTIVE',
      },
    },
  );

  // Delete or hide the old Payment Method (using Sequelize) - destroy instead of delete
  await oldPaymentMethod.destroy();

  return newPaymentMethod;
}

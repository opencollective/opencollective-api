import { URLSearchParams } from 'url';

import { pick } from 'lodash';

import { activities } from '../../../constants';
import ORDER_STATUS from '../../../constants/order-status';
import { PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import logger from '../../../lib/logger';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models, { Op } from '../../../models';
import GiftCard from '../../../paymentProviders/opencollective/giftcard';
import { setupCreditCard } from '../../../paymentProviders/stripe/creditcard';
import { Forbidden, ValidationFailed } from '../../errors';

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
  if (args.type === PAYMENT_METHOD_TYPE.GIFTCARD) {
    // either amount or monthlyLimitPerMember needs to be present
    if (!args.amount && !args.monthlyLimitPerMember) {
      throw new Error('you need to define either the amount or the monthlyLimitPerMember of the payment method.');
    }
    return createGiftCardPaymentMethod(args, remoteUser);
  } else if (args.service === 'stripe' && args.type === 'creditcard') {
    return createStripeCreditCard(args, remoteUser);
  } else {
    throw new Error('Payment method type not supported');
  }
}

/** Create the Gift Card Payment Method through an organization
 *
 * @param {Object} args contains the parameters to create the new
 *  payment method.
 * @param {String} [args.description] The description of the new payment
 *  method.
 * @param {Number} args.CollectiveId The ID of the organization creating the gift card.
 * @param {Number} [args.PaymentMethodId] The ID of the Source Payment method the
 *                 organization wants to use
 * @param {Number} args.amount The total amount that will be
 *  credited to the newly created payment method.
 * @param {String} args.currency The currency of the gift card
 * @param {[limitedToTags]} [args.limitedToTags] Limit this payment method to donate to collectives having those tags
 * @param {Date} [args.expiryDate] The expiry date of the payment method
 * @param {Object} remoteUser logged in user
 * @returns {models.PaymentMethod} return the gift card payment method.
 */
async function createGiftCardPaymentMethod(args, remoteUser) {
  // making sure it's a string, trim and uppercase it.
  args.currency = args.currency.toString().toUpperCase();
  if (!['USD', 'EUR'].includes(args.currency)) {
    throw new Error(`Currency ${args.currency} not supported. We only support USD and EUR at the moment.`);
  }
  const paymentMethod = await GiftCard.create(args, remoteUser);
  return paymentMethod;
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

/** Claim the Gift Card Payment Method By an (existing or not) user
 * @param {Object} args contains the parameters
 * @param {String} args.code The 8 last digits of the UUID
 * @param {String} args.email The email of the user claiming the gift card
 * @returns {models.PaymentMethod} return the gift card payment method.
 */
export async function claimPaymentMethod(args, remoteUser) {
  const paymentMethod = await GiftCard.claim(args, remoteUser);
  const user = await models.User.findOne({
    where: { CollectiveId: paymentMethod.CollectiveId },
  });
  const { initialBalance, monthlyLimitPerMember, currency, name, expiryDate } = paymentMethod;
  const amount = initialBalance || monthlyLimitPerMember;
  const emitter = await models.Collective.findByPk(paymentMethod.sourcePaymentMethod.CollectiveId);

  const qs = new URLSearchParams({
    code: paymentMethod.uuid.substring(0, 8),
  }).toString();

  // If the User is already authenticated it doesn't need this email
  // It will be redirected to the /redeemed page
  // See: https://github.com/opencollective/opencollective-frontend/blob/08323de06714c20ce33e93bfebcbbeb0af587413/src/pages/redeem.js#L143
  if (!remoteUser) {
    await models.Activity.create({
      type: activities.USER_CARD_CLAIMED,
      UserId: user.id,
      CollectiveId: user.CollectiveId,
      FromCollectiveId: emitter.id,
      data: {
        loginLink: user.generateLoginLink(`/redeemed?${qs}`),
        initialBalance: amount,
        name,
        currency,
        expiryDate,
        emitter: emitter.info,
      },
    });
  }

  return paymentMethod;
}

/** Archive the given payment method */
const PaymentMethodPermissionError = new Forbidden(
  "This payment method does not exist or you don't have the permission to edit it.",
);

export async function removePaymentMethod(paymentMethodId, req) {
  if (!req.remoteUser) {
    throw PaymentMethodPermissionError;
  }

  // Try to load payment method. Throw permission error if it doesn't exist
  // to prevent attackers from guessing which id is valid and which one is not
  const paymentMethod = await models.PaymentMethod.findByPk(paymentMethodId, {
    include: [{ model: models.Collective, required: true }],
  });
  if (!paymentMethod || !req.remoteUser.isAdmin(paymentMethod.CollectiveId)) {
    throw PaymentMethodPermissionError;
  }

  await twoFactorAuthLib.enforceForAccount(req, paymentMethod.Collective);

  // Block the removal if the payment method has subscriptions linked
  const subscriptions = await paymentMethod.getOrders({
    where: { status: { [Op.or]: [ORDER_STATUS.ACTIVE, ORDER_STATUS.ERROR] } },
    include: [
      {
        model: models.Subscription,
        as: 'subscription',
        where: { isActive: true },
        required: true,
      },
    ],
  });

  if (subscriptions.length > 0) {
    throw new ValidationFailed('The payment method has active subscriptions', 'PM.Remove.HasActiveSubscriptions');
  }

  return paymentMethod.destroy();
}

/** Update payment method with given args */
export async function updatePaymentMethod(args, req) {
  const allowedFields = ['name', 'monthlyLimitPerMember'];
  const paymentMethod = await models.PaymentMethod.findByPk(args.id, {
    include: [{ model: models.Collective, required: true }],
  });
  if (!paymentMethod || !req.remoteUser || !req.remoteUser.isAdminOfCollective(paymentMethod.Collective)) {
    throw PaymentMethodPermissionError;
  }

  await twoFactorAuthLib.enforceForAccount(req, paymentMethod.Collective, { onlyAskOnLogin: true });

  return paymentMethod.update(pick(args, allowedFields));
}

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

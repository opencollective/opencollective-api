import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import models from '../../../models';
import { setupCreditCard } from '../../../paymentProviders/stripe/creditcard';
import { Forbidden, ValidationFailed } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { CreditCardCreateInput } from '../input/CreditCardCreateInput';
import { PaymentMethodCreateInput } from '../input/PaymentMethodCreateInput';
import { PaymentMethod } from '../object/PaymentMethod';

const addCreditCard = {
  type: new GraphQLNonNull(PaymentMethod),
  description: 'Add a new payment method to be used with an Order',
  args: {
    paymentMethod: {
      type: PaymentMethodCreateInput,
      description: 'A Payment Method to add to an Account',
      deprecationReason: '2020-08-24: Please use creditCardInfo',
    },
    creditCardInfo: {
      type: CreditCardCreateInput,
      description: 'The credit card info',
    },
    name: {
      type: GraphQLString,
      description: 'Name associated to this credit card',
    },
    isSavedForLater: {
      type: GraphQLBoolean,
      description: 'Wether this payment method should be saved for future payments',
      defaultValue: true,
    },
    account: {
      type: new GraphQLNonNull(AccountReferenceInput),
      description: 'Account to add Payment Method to',
    },
  },
  async resolve(_, args, req) {
    const collective = await fetchAccountWithReference(args.account, { throwIfMissing: true });
    if (!req.remoteUser.isAdminOfCollective(collective)) {
      throw new Forbidden(`Must be an admin of ${collective.name}`);
    }

    const newPaymentMethodData = {
      service: 'stripe',
      type: 'creditcard',
      name: args.name,
      CreatedByUserId: req.remoteUser.id,
      currency: collective.currency,
      saved: args.isSavedForLater,
      CollectiveId: collective.id,
    };

    if (args.creditCardInfo) {
      const data = pick(args.creditCardInfo, ['brand', 'country', 'expMonth', 'expYear', 'fullName', 'funding', 'zip']);
      Object.assign(newPaymentMethodData, { token: args.creditCardInfo.token, data });
    } else if (args.paymentMethod) {
      Object.assign(newPaymentMethodData, pick(args.paymentMethod, ['data', 'name', 'token']));
    } else {
      throw new ValidationFailed('Either creditCardInfo or paymentMethod must be provided');
    }

    let pm = await models.PaymentMethod.create(newPaymentMethodData);
    try {
      pm = await setupCreditCard(pm, { collective, user: req.remoteUser });
    } catch (error) {
      if (!error.stripeResponse) {
        throw error;
      }

      // TODO Add support for 3D secure
      // Currently ignoring the error, which should be ok because we have the `payment.creditcard.confirmation` email.
    }

    return pm;
  },
};

const paymentMethodMutations = {
  addCreditCard,
  addStripeCreditCard: {
    ...addCreditCard,
    deprecationReason: '2020-08-24: Use addCreditCard',
  },
};

export default paymentMethodMutations;

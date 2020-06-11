import models from '../../../models';
import { setupCreditCard } from '../../../paymentProviders/stripe/creditcard';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { PaymentMethodCreateInput } from '../input/PaymentMethodCreateInput';
import { PaymentMethod } from '../object/PaymentMethod';

const paymentMethodMutations = {
  addStripeCreditCard: {
    type: PaymentMethod,
    description: 'Add a new payment method to be used with an Order',
    args: {
      paymentMethod: {
        type: PaymentMethodCreateInput,
        description: 'A Payment Method to add to an Account',
      },
      account: {
        type: AccountReferenceInput,
        description: 'Account to add Payment Method to',
      },
    },
    async resolve(_, args) {
      const account = await fetchAccountWithReference(args.account);
      const collective = await models.Collective.findByPk(account.id);
      if (!collective) {
        throw Error('This collective does not exist');
      }

      const { paymentMethod } = args;

      const newPaymentMethodData = {
        ...paymentMethod,
        service: 'stripe',
        type: 'creditcard',
        CreatedByUserId: account.CreatedByUserId,
        currency: account.currency,
        saved: true,
        CollectiveId: account.id,
      };

      let pm = await models.PaymentMethod.create(newPaymentMethodData);

      try {
        pm = await setupCreditCard(pm, {
          collective,
          user: account,
        });
      } catch (error) {
        if (!error.stripeResponse) {
          throw error;
        }

        pm.stripeError = {
          message: error.message,
          response: error.stripeResponse,
        };
      }
      return pm;
    },
  },
};

export default paymentMethodMutations;

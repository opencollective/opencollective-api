import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { find, get } from 'lodash';

import { PayoutMethodTypes } from '../../../models/PayoutMethod';
import { PaymentMethodType, PayoutMethodType } from '../enum';
import { Account, AccountFields } from '../interface/Account';
import URL from '../scalar/URL';

import { HostPlan } from './HostPlan';

export const Host = new GraphQLObjectType({
  name: 'Host',
  description: 'This represents an Host account',
  interfaces: () => [Account],
  fields: () => {
    return {
      ...AccountFields,
      hostFeePercent: {
        type: GraphQLInt,
        resolve(collective) {
          return collective.hostFeePercent;
        },
      },
      totalHostedCollectives: {
        type: GraphQLInt,
        resolve(collective) {
          return collective.getHostedCollectivesCount();
        },
      },
      isOpenToApplications: {
        type: GraphQLBoolean,
        resolve(collective) {
          return collective.canApply();
        },
      },
      termsUrl: {
        type: URL,
        resolve(collective) {
          return get(collective, 'settings.tos');
        },
      },
      plan: {
        type: new GraphQLNonNull(HostPlan),
        resolve(host) {
          return host.getPlan();
        },
      },
      supportedPaymentMethods: {
        type: new GraphQLList(PaymentMethodType),
        description:
          'The list of payment methods (Stripe, Paypal, manual bank transfer, etc ...) the Host can accept for its Collectives',
        async resolve(collective, _, req) {
          const supportedPaymentMethods = [];

          // Paypal, Stripe = connected accounts
          const connectedAccounts = await req.loaders.Collective.connectedAccounts.load(collective.id);

          if (find(connectedAccounts, ['service', 'stripe'])) {
            supportedPaymentMethods.push('CREDIT_CARD');
          }

          if (find(connectedAccounts, ['service', 'paypal'])) {
            supportedPaymentMethods.push('PAYPAL');
          }

          // bank transfer = manual in host settings
          if (get(collective, 'settings.paymentMethods.manual', null)) {
            supportedPaymentMethods.push('BANK_TRANSFER');
          }

          return supportedPaymentMethods;
        },
      },
      supportedPayoutMethods: {
        type: new GraphQLList(PayoutMethodType),
        description: 'The list of payout methods this Host accepts for its expenses',
        async resolve(collective, _, req) {
          const connectedAccounts = await req.loaders.Collective.connectedAccounts.load(collective.id);
          const supportedPayoutMethods = [PayoutMethodTypes.OTHER, PayoutMethodTypes.ACCOUNT_BALANCE];
          if (connectedAccounts?.find?.(c => c.service === 'transferwise')) {
            supportedPayoutMethods.push(PayoutMethodTypes.BANK_ACCOUNT);
          }
          if (!collective.settings?.disablePaypalPayouts) {
            supportedPayoutMethods.push(PayoutMethodTypes.PAYPAL);
          }

          return supportedPayoutMethods;
        },
      },
    };
  },
});

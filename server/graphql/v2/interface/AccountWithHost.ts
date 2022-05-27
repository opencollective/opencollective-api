import { GraphQLBoolean, GraphQLFloat, GraphQLInt, GraphQLInterfaceType, GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { HOST_FEE_STRUCTURE } from '../../../constants/host-fee-structure';
import models from '../../../models';
import { hostResolver } from '../../common/collective';
import { HostFeeStructure } from '../enum/HostFeeStructure';
import { PaymentMethodService } from '../enum/PaymentMethodService';
import { PaymentMethodType } from '../enum/PaymentMethodType';
import { Host } from '../object/Host';

export const AccountWithHostFields = {
  host: {
    description: 'Returns the Fiscal Host',
    type: Host,
    resolve: hostResolver,
  },
  hostFeesStructure: {
    description: 'Describe how the host charges the collective',
    type: HostFeeStructure,
    resolve: (account: typeof models.Collective): HOST_FEE_STRUCTURE | null => {
      if (!account.HostCollectiveId) {
        return null;
      } else if (account.data?.useCustomHostFee) {
        return HOST_FEE_STRUCTURE.CUSTOM_FEE;
      } else {
        return HOST_FEE_STRUCTURE.DEFAULT;
      }
    },
  },
  hostFeePercent: {
    description: 'Fees percentage that the host takes for this collective',
    type: GraphQLFloat,
    args: {
      paymentMethodService: { type: PaymentMethodService },
      paymentMethodType: { type: PaymentMethodType },
    },
    resolve(account: typeof models.Collective, args): Promise<number> {
      if (args.paymentMethodType === 'host' && account.data?.addedFundsHostFeePercent) {
        return account.data?.addedFundsHostFeePercent;
      } else if (args.paymentMethodType === 'manual' && account.data?.bankTransfersHostFeePercent) {
        return account.data?.bankTransfersHostFeePercent;
      } else if (args.paymentMethodType === 'creditcard' && account.data?.creditCardHostFeePercent) {
        return account.data?.creditCardHostFeePercent;
      } else if (args.paymentMethodService === 'stripe' && account.data?.creditCardHostFeePercent) {
        return account.data?.creditCardHostFeePercent;
      } else if (args.paymentMethodService === 'paypal' && account.data?.paypalHostFeePercent) {
        return account.data?.paypalHostFeePercent;
      }
      return account.hostFeePercent;
    },
  },
  platformFeePercent: {
    description: 'Fees percentage that the platform takes for this collective',
    type: GraphQLInt,
  },
  approvedAt: {
    description: 'Date of approval by the Fiscal Host.',
    type: GraphQLDateTime,
    resolve(account: typeof models.Collective): Promise<Date> {
      return account.approvedAt;
    },
  },
  isApproved: {
    description: "Returns whether it's approved by the Fiscal Host",
    type: new GraphQLNonNull(GraphQLBoolean),
    resolve(account: typeof models.Collective): boolean {
      return account.isApproved();
    },
  },
  isActive: {
    description: "Returns whether it's active: can accept financial contributions and pay expenses.",
    type: new GraphQLNonNull(GraphQLBoolean),
    resolve(account: typeof models.Collective): boolean {
      return Boolean(account.isActive);
    },
  },
};

export const AccountWithHost = new GraphQLInterfaceType({
  name: 'AccountWithHost',
  description: 'An account that can be hosted by a Host',
  fields: () => AccountWithHostFields,
});

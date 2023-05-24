import { GraphQLBoolean, GraphQLFloat, GraphQLInterfaceType, GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { isNumber } from 'lodash';

import { HOST_FEE_STRUCTURE } from '../../../constants/host-fee-structure';
import { Collective } from '../../../models';
import Agreement from '../../../models/Agreement';
import { hostResolver } from '../../common/collective';
import { Unauthorized } from '../../errors';
import { AgreementCollection } from '../collection/AgreementCollection';
import { HostFeeStructure } from '../enum/HostFeeStructure';
import { PaymentMethodService } from '../enum/PaymentMethodService';
import { PaymentMethodType } from '../enum/PaymentMethodType';
import { Host } from '../object/Host';

import { CollectionArgs } from './Collection';

export const AccountWithHostFields = {
  host: {
    description: 'Returns the Fiscal Host',
    type: Host,
    resolve: hostResolver,
  },
  hostFeesStructure: {
    description: 'Describe how the host charges the collective',
    type: HostFeeStructure,
    resolve: (account: Collective): HOST_FEE_STRUCTURE | null => {
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
    async resolve(account: Collective, args, req): Promise<number> {
      const parent = await req.loaders.Collective.parent.load(account);
      const host = await req.loaders.Collective.host.load(account);
      const possibleValues = [];

      if (args.paymentMethodType === 'host') {
        possibleValues.push(account.data?.addedFundsHostFeePercent);
        possibleValues.push(parent?.data?.addedFundsHostFeePercent);
        if (account.data?.useCustomHostFee) {
          possibleValues.push(account.hostFeePercent);
        }
        if (parent?.data?.useCustomHostFee) {
          possibleValues.push(parent?.hostFeePercent);
        }
        possibleValues.push(host?.data?.addedFundsHostFeePercent);
      } else if (args.paymentMethodType === 'manual') {
        possibleValues.push(account.data?.bankTransfersHostFeePercent);
        possibleValues.push(parent?.data?.bankTransfersHostFeePercent);
        if (account.data?.useCustomHostFee) {
          possibleValues.push(account.hostFeePercent);
        }
        if (parent?.data?.useCustomHostFee) {
          possibleValues.push(parent?.hostFeePercent);
        }
        possibleValues.push(host?.data?.bankTransfersHostFeePercent);
      } else if (args.paymentMethodService === 'stripe') {
        // the setting used to be named `creditCardHostFeePercent` but it's meant to be used for Stripe generally
        // to be removed once we don't have Hosts with `creditCardHostFeePercent`
        possibleValues.push(account.data?.creditCardHostFeePercent);
        possibleValues.push(parent?.data?.creditCardHostFeePercent);
        possibleValues.push(account.data?.stripeHostFeePercent);
        possibleValues.push(parent?.data?.stripeHostFeePercent);
        if (account.data?.useCustomHostFee) {
          possibleValues.push(account.hostFeePercent);
        }
        if (parent?.data?.useCustomHostFee) {
          possibleValues.push(parent?.hostFeePercent);
        }
        possibleValues.push(host?.data?.creditCardHostFeePercent);
        possibleValues.push(host?.data?.stripeHostFeePercent);
      } else if (args.paymentMethodService === 'paypal') {
        possibleValues.push(account.data?.paypalHostFeePercent);
        possibleValues.push(parent?.data?.paypalHostFeePercent);
        if (account.data?.useCustomHostFee) {
          possibleValues.push(account.hostFeePercent);
        }
        if (parent?.data?.useCustomHostFee) {
          possibleValues.push(parent?.hostFeePercent);
        }
        possibleValues.push(host?.data?.paypalHostFeePercent);
      }

      possibleValues.push(account.hostFeePercent);

      // Pick the first that is set as a Number
      return possibleValues.find(isNumber);
    },
  },
  platformFeePercent: {
    description: 'Fees percentage that the platform takes for this collective',
    type: GraphQLFloat,
  },
  approvedAt: {
    description: 'Date of approval by the Fiscal Host.',
    type: GraphQLDateTime,
    resolve(account: Collective): Date {
      return account.approvedAt;
    },
  },
  isApproved: {
    description: "Returns whether it's approved by the Fiscal Host",
    type: new GraphQLNonNull(GraphQLBoolean),
    resolve(account: Collective): boolean {
      return account.isApproved();
    },
  },
  isActive: {
    description: "Returns whether it's active: can accept financial contributions and pay expenses.",
    type: new GraphQLNonNull(GraphQLBoolean),
    resolve(account: Collective): boolean {
      return Boolean(account.isActive);
    },
  },
  hostAgreements: {
    type: new GraphQLNonNull(AgreementCollection),
    description: 'Returns agreements this account has with its host',
    args: {
      ...CollectionArgs,
    },
    async resolve(account, args, req) {
      if (!account.HostCollectiveId) {
        return { totalCount: 0, limit: args.limit, offset: args.offset, nodes: [] };
      }

      if (!req.remoteUser?.isAdmin(account.HostCollectiveId)) {
        throw new Unauthorized("You need to be logged in as an admin of the account's host to see its agreements");
      }

      const totalCount = await req.loaders.Agreement.totalAccountHostAgreements.load(account.id);
      const agreements =
        args.limit <= 0
          ? []
          : await Agreement.findAll({
              where: {
                HostCollectiveId: account.HostCollectiveId,
                CollectiveId: account.id,
              },
              limit: args.limit,
              offset: args.offset,
              order: [['createdAt', 'desc']],
            });

      return {
        totalCount,
        limit: args.limit,
        offset: args.offset,
        nodes: agreements,
      };
    },
  },
};

export const AccountWithHost = new GraphQLInterfaceType({
  name: 'AccountWithHost',
  description: 'An account that can be hosted by a Host',
  fields: () => AccountWithHostFields,
});

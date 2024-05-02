import { GraphQLBoolean, GraphQLFloat, GraphQLInterfaceType, GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { clamp, isNumber } from 'lodash';

import { roles } from '../../../constants';
import { HOST_FEE_STRUCTURE } from '../../../constants/host-fee-structure';
import Agreement from '../../../models/Agreement';
import Collective from '../../../models/Collective';
import HostApplication from '../../../models/HostApplication';
import { hostResolver } from '../../common/collective';
import { GraphQLAgreementCollection } from '../collection/AgreementCollection';
import { GraphQLHostFeeStructure } from '../enum/HostFeeStructure';
import { GraphQLPaymentMethodService } from '../enum/PaymentMethodService';
import { GraphQLPaymentMethodType } from '../enum/PaymentMethodType';
import { GraphQLHost } from '../object/Host';
import { GraphQLHostApplication } from '../object/HostApplication';

import { getCollectionArgs } from './Collection';

export const AccountWithHostFields = {
  host: {
    description: 'Returns the Fiscal Host',
    type: GraphQLHost,
    resolve: hostResolver,
  },
  hostFeesStructure: {
    description: 'Describe how the host charges the collective',
    type: GraphQLHostFeeStructure,
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
      paymentMethodService: { type: GraphQLPaymentMethodService },
      paymentMethodType: { type: GraphQLPaymentMethodType },
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
      } else if (args.paymentMethodType === 'collective') {
        // Default to 0 for Collective to Collective on the same Host
        possibleValues.push(0);
      } else if (args.paymentMethodService === 'stripe') {
        // possibleValues.push(account.data?.stripeHostFeePercent);
        // possibleValues.push(parent?.data?.stripeHostFeePercent);
        if (account.data?.useCustomHostFee) {
          possibleValues.push(account.hostFeePercent);
        }
        if (parent?.data?.useCustomHostFee) {
          possibleValues.push(parent?.hostFeePercent);
        }
        // possibleValues.push(host?.data?.stripeHostFeePercent);
      } else if (args.paymentMethodService === 'paypal') {
        // possibleValues.push(account.data?.paypalHostFeePercent);
        // possibleValues.push(parent?.data?.paypalHostFeePercent);
        if (account.data?.useCustomHostFee) {
          possibleValues.push(account.hostFeePercent);
        }
        if (parent?.data?.useCustomHostFee) {
          possibleValues.push(parent?.hostFeePercent);
        }
        // possibleValues.push(host?.data?.paypalHostFeePercent);
      }

      possibleValues.push(account.hostFeePercent);

      // Pick the first that is set as a Number
      return possibleValues.find(isNumber);
    },
  },
  hostApplication: {
    description: 'Returns the Fiscal Host application',
    type: GraphQLHostApplication,
    resolve: (account: Collective): Promise<HostApplication> | null => {
      if (account.ParentCollectiveId) {
        return null;
      }
      return HostApplication.findOne({
        order: [['createdAt', 'DESC']],
        where: {
          HostCollectiveId: account.HostCollectiveId,
          CollectiveId: account.id,
        },
      });
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
    type: GraphQLAgreementCollection,
    description: 'Returns agreements this account has with its host, or null if not enough permissions.',
    args: {
      ...getCollectionArgs({ limit: 30 }),
    },
    async resolve(account, args, req) {
      if (!account.HostCollectiveId) {
        return { totalCount: 0, limit: args.limit, offset: args.offset, nodes: [] };
      }

      if (
        !req.remoteUser?.isAdmin(account.HostCollectiveId) &&
        !req.remoteUser?.hasRole(roles.ACCOUNTANT, account.HostCollectiveId)
      ) {
        return null;
      }

      const totalCount = await req.loaders.Agreement.totalAccountHostAgreements.load(account.id);
      const offset = clamp(args.offset || 0, 0, totalCount);
      const limit = clamp(args.limit || 30, 0, 100);
      return {
        totalCount,
        limit: limit,
        offset: offset,
        nodes: () => {
          return Agreement.findAll({
            where: {
              HostCollectiveId: account.HostCollectiveId,
              CollectiveId: [account.id, account.ParentCollectiveId].filter(Boolean),
            },
            limit: limit,
            offset: offset,
            order: [['createdAt', 'desc']],
          });
        },
      };
    },
  },
};

export const GraphQLAccountWithHost = new GraphQLInterfaceType({
  name: 'AccountWithHost',
  description: 'An account that can be hosted by a Host',
  fields: () => AccountWithHostFields,
});

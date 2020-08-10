import { GraphQLBoolean, GraphQLFloat, GraphQLInt, GraphQLInterfaceType, GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { HOST_FEE_STRUCTURE } from '../../../constants/host-fee-structure';
import { hostResolver } from '../../common/collective';
import { HostFeeStructure } from '../enum/HostFeeStructure';
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
    resolve: (account): HOST_FEE_STRUCTURE | null => {
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
  },
  platformFeePercent: {
    description: 'Fees percentage that the platform takes for this collective',
    type: GraphQLInt,
  },
  approvedAt: {
    description: 'Date of approval by the Fiscal Host.',
    type: GraphQLDateTime,
    resolve(account): Promise<Date> {
      return account.approvedAt;
    },
  },
  isApproved: {
    description: "Returns whether it's approved by the Fiscal Host",
    type: GraphQLNonNull(GraphQLBoolean),
    resolve(account): boolean {
      return account.isApproved();
    },
  },
  isActive: {
    description: "Returns whether it's active: can accept financial contributions and pay expenses.",
    type: GraphQLNonNull(GraphQLBoolean),
    resolve(account): boolean {
      return Boolean(account.isActive);
    },
  },
};

export const AccountWithHost = new GraphQLInterfaceType({
  name: 'AccountWithHost',
  description: 'An account that can be hosted by a Host',
  fields: () => AccountWithHostFields,
});

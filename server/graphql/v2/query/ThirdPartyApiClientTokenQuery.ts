import { GraphQLEnumType, GraphQLNonNull, GraphQLString } from 'graphql';

import logger from '../../../lib/logger';
import {
  generateBraintreeTokenForClient,
  getBraintreeGatewayForCollective,
} from '../../../paymentProviders/braintree/gateway';
import { Forbidden } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';

const ThirdPartyApiWithClientToken = new GraphQLEnumType({
  name: 'ThirdPartyApiWithClientToken',
  description: 'Third party APIs for which Open Collective API can generate tokens',
  values: {
    BRAINTREE: {},
  },
});

const ThirdPartyApiClientTokenQuery = {
  type: new GraphQLNonNull(GraphQLString),
  args: {
    account: {
      type: new GraphQLNonNull(AccountReferenceInput),
      description: 'The account that serves as a payment target',
    },
    fromAccount: {
      type: AccountReferenceInput,
      description: 'The account that is contributing',
    },
    service: {
      type: new GraphQLNonNull(ThirdPartyApiWithClientToken),
      description: '',
    },
  },
  async resolve(_, args, req): Promise<string> {
    if (args.service === 'BRAINTREE') {
      const collective = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      let fromCollective;
      if (args.fromAccount) {
        fromCollective = await fetchAccountWithReference(args.fromAccount, { throwIfMissing: true });
        if (!req.remoteUser?.isAdminOfCollective(fromCollective)) {
          throw new Forbidden(`You need to be an admin of ${fromCollective.slug} to use its payment methods`);
        }
      }

      const gateway = await getBraintreeGatewayForCollective(collective);
      try {
        return generateBraintreeTokenForClient(gateway, fromCollective);
      } catch (e) {
        // If it fails while using fromCollective, we generate a generic token. Saved payment
        // methods will be missing in the form, but it makes sure that a deleted customer will
        // not crash the flow.
        if (fromCollective) {
          logger.info(`Invalid customerId for ${fromCollective.slug}, using default gateway`);
          return generateBraintreeTokenForClient(gateway);
        } else {
          throw e;
        }
      }
    } else {
      throw new Error('Provider not supported');
    }
  },
};

export default ThirdPartyApiClientTokenQuery;

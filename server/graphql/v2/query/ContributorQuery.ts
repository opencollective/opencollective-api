import { GraphQLNonNull } from 'graphql';

import { getHostContributorDetail } from '../../../lib/contributors';
import { BadRequest } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLContributor } from '../object/Contributor';

const ContributorQuery = {
  description: 'Get Contributors grouped by their profiles',
  type: GraphQLContributor,
  args: {
    account: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'Contributor Account reference',
    },
    host: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'Context host to fetch the contributor from',
    },
  },
  async resolve(_: void, args, req: Express.Request) {
    const [account, host] = await Promise.all([
      fetchAccountWithReference(args.account, { throwIfMissing: true }),
      fetchAccountWithReference(args.host, { throwIfMissing: true }),
    ]);
    if (!req.remoteUser?.isAdminOfCollective(host)) {
      throw new BadRequest('Only admins can lookup for members using the "host" argument');
    }

    return getHostContributorDetail(account.id, host.id);
  },
};

export default ContributorQuery;

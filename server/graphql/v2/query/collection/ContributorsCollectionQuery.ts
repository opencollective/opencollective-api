import assert from 'assert';

import { GraphQLInt, GraphQLList, GraphQLNonNull } from 'graphql';
import { isNil } from 'lodash';

import { countHostContributors, getHostContributors } from '../../../../lib/contributors';
import { BadRequest } from '../../../errors';
import { GraphQLContributorCollection } from '../../collection/ContributorCollection';
import { AccountTypeToModelMapping, GraphQLAccountType } from '../../enum/AccountType';
import { GraphQLMemberRole } from '../../enum/MemberRole';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import EmailAddress from '../../scalar/EmailAddress';

const DEFAULT_LIMIT = 100;

const ContributorsCollectionQuery = {
  description: 'Get Contributors grouped by their profiles',
  type: new GraphQLNonNull(GraphQLContributorCollection),
  args: {
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'Host hosting the account',
    },
    host: {
      type: GraphQLAccountReferenceInput,
      description: 'Host hosting the account',
    },
    role: { type: new GraphQLList(GraphQLMemberRole) },
    type: { type: new GraphQLList(GraphQLAccountType) },
    email: {
      type: EmailAddress,
      description: 'Admin only. To filter on the email address of a member, useful to check if a member exists.',
    },
    limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: DEFAULT_LIMIT },
    offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
  },
  async resolve(_: void, args, req: Express.Request) {
    if (isNil(args.limit) || args.limit < 0) {
      args.limit = DEFAULT_LIMIT;
    }
    if (isNil(args.offset) || args.offset < 0) {
      args.offset = 0;
    }
    if (args.limit > DEFAULT_LIMIT && !req.remoteUser?.isRoot()) {
      throw new Error(`Cannot fetch more than ${DEFAULT_LIMIT},members at the same time, please adjust the limit`);
    }

    assert(
      Boolean(args.account) !== Boolean(args.host),
      'You must provide either an account or a host to fetch the contributors',
    );

    const replacements: {
      limit: number;
      offset: number;
      type?: string[];
      role?: string[];
      collectiveid?: number;
      hostid?: number;
      email?: string;
    } = {
      limit: args.limit,
      offset: args.offset,
    };

    if (args.type && args.type.length > 0) {
      replacements['type'] = args.type.map(value => AccountTypeToModelMapping[value]);
    }

    if (args.role && args.role.length > 0) {
      replacements['role'] = args.role;
    }

    let account, host;
    if (args.account) {
      account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      replacements['collectiveid'] = account.id;
    }

    if (args.host) {
      host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
      if (!req.remoteUser?.isAdminOfCollective(host)) {
        throw new BadRequest('Only admins can lookup for members using the "host" argument');
      }
      replacements['hostid'] = host.id;
    }

    if (args.email) {
      if (req.remoteUser?.isAdminOfCollective(account) || req.remoteUser?.isAdminOfCollective(host)) {
        replacements['email'] = args.email.toLowerCase();
      } else {
        throw new BadRequest('Only admins can lookup for members using the "email" argument');
      }
    }

    const nodes = () => getHostContributors(replacements);
    const totalCount = () => countHostContributors(replacements);

    return { nodes, totalCount, limit: args.limit, offset: args.offset };
  },
};

export default ContributorsCollectionQuery;

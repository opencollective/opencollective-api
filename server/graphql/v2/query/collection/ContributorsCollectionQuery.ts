import assert from 'assert';

import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull } from 'graphql';
import { isNil } from 'lodash';

import { ifStr } from '../../../../lib/utils';
import { sequelize } from '../../../../models';
import { BadRequest } from '../../../errors';
import { GraphQLContributorCollection } from '../../collection/ContributorCollection';
import { AccountTypeToModelMapping, GraphQLAccountType } from '../../enum/AccountType';
import { GraphQLMemberRole } from '../../enum/MemberRole';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import { GraphQLChronologicalOrderInput } from '../../input/ChronologicalOrderInput';
import EmailAddress from '../../scalar/EmailAddress';

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
    limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
    offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
    role: { type: new GraphQLList(GraphQLMemberRole) },
    type: { type: new GraphQLList(GraphQLAccountType) },
    email: {
      type: EmailAddress,
      description: 'Admin only. To filter on the email address of a member, useful to check if a member exists.',
    },
    orderBy: {
      type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
      defaultValue: { field: 'createdAt', direction: 'ASC' },
      description: 'Order of the results',
    },
    includeInherited: {
      type: GraphQLBoolean,
      defaultValue: true,
    },
  },
  async resolve(_: void, args, req: Express.Request) {
    // Check Pagination arguments
    if (isNil(args.limit) || args.limit < 0) {
      args.limit = 100;
    }
    if (isNil(args.offset) || args.offset < 0) {
      args.offset = 0;
    }
    if (args.limit > 100 && !req.remoteUser?.isRoot()) {
      throw new Error('Cannot fetch more than 1,000 members at the same time, please adjust the limit');
    }

    assert(args.account || args.host, 'You must provide either an account or a host to fetch the contributors');

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

    const baseQuery = `
      FROM
        "Collectives" mc
        INNER JOIN "Members" m ON mc.id = m."MemberCollectiveId" AND m."deletedAt" IS NULL
        INNER JOIN "Collectives" c ON c.id = m."CollectiveId" AND c."deletedAt" IS NULL
        LEFT JOIN "Users" u ON u."CollectiveId" = mc.id AND u."deletedAt" IS NULL
      WHERE mc."deletedAt" IS NULL
        AND mc."isIncognito" = FALSE
        ${ifStr(replacements.email, 'AND u.email = :email')}
        ${ifStr(replacements.type, 'AND mc.type in (:type)')}
        ${ifStr(replacements.role, 'AND m.role in (:role)')}
        ${ifStr(replacements.collectiveid, 'AND c."id" = :collectiveid')}
        ${ifStr(replacements.hostid, 'AND c."HostCollectiveId" = :hostid AND c."approvedAt" IS NOT NULL')}
    `;

    const nodes = () =>
      sequelize.query(
        `
          SELECT mc.*,
            ARRAY_AGG(DISTINCT (m.role)) as roles,
            ARRAY_AGG(DISTINCT (c.id)) as "ContributedCollectiveIds",
            'ADMIN' = ANY (ARRAY_AGG(m.role)) as "isAdmin",
            'ADMIN' = ANY (ARRAY_AGG(m.role))  OR 'MEMBER' = ANY (ARRAY_AGG(m.role)) as "isCore",
            'BACKER' = ANY (ARRAY_AGG(m.role)) as "isBacker"
          ${baseQuery}
          GROUP BY
          mc.id
            ORDER BY mc."createdAt" DESC
            LIMIT :limit
            OFFSET :offset;
        `,
        { replacements, type: sequelize.QueryTypes.SELECT, raw: true },
      );

    const totalCount = async () => {
      const result = await sequelize.query(
        `
          SELECT COUNT(DISTINCT (mc.id))
          ${baseQuery}
        `,
        { replacements, type: sequelize.QueryTypes.SELECT, raw: true },
      );
      return result[0].count;
    };

    return { nodes, totalCount, limit: args.limit, offset: args.offset };
  },
};

export default ContributorsCollectionQuery;

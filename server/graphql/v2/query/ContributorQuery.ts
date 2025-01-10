import assert from 'assert';

import { GraphQLNonNull } from 'graphql';

import { sequelize } from '../../../models';
import { BadRequest } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLContributor } from '../object/Contributor';

const ContributorQuery = {
  description: 'Get Contributors grouped by their profiles',
  type: new GraphQLNonNull(GraphQLContributor),
  args: {
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'Contributor Account reference',
    },
    host: {
      type: GraphQLAccountReferenceInput,
      description: 'Context host to fetch the contributor from',
    },
  },
  async resolve(_: void, args, req: Express.Request) {
    assert(args.account && args.host, 'You must provide either an account or a host to fetch the contributors');
    const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
    const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
    if (!req.remoteUser?.isAdminOfCollective(host)) {
      throw new BadRequest('Only admins can lookup for members using the "host" argument');
    }

    const result = await sequelize.query(
      `
        SELECT mc.*,
          ARRAY_AGG(DISTINCT (m.role)) as roles,
          ARRAY_AGG(DISTINCT (c.id)) as "ContributedCollectiveIds",
          'ADMIN' = ANY (ARRAY_AGG(m.role)) as "isAdmin",
          'ADMIN' = ANY (ARRAY_AGG(m.role))  OR 'MEMBER' = ANY (ARRAY_AGG(m.role)) as "isCore",
          'BACKER' = ANY (ARRAY_AGG(m.role)) as "isBacker"
        FROM
          "Collectives" mc
          INNER JOIN "Members" m ON mc.id = m."MemberCollectiveId" AND m."deletedAt" IS NULL
          INNER JOIN "Collectives" c ON c.id = m."CollectiveId" AND c."deletedAt" IS NULL
          LEFT JOIN "Users" u ON u."CollectiveId" = mc.id AND u."deletedAt" IS NULL
        WHERE mc."deletedAt" IS NULL
          AND mc."isIncognito" = FALSE
          AND mc."id" = :accountid
          AND c."HostCollectiveId" = :hostid AND c."approvedAt" IS NOT NULL
            GROUP BY
          mc.id
            ORDER BY mc."createdAt" DESC
        LIMIT 1;
        `,
      {
        replacements: {
          accountid: account.id,
          hostid: host.id,
        },
        type: sequelize.QueryTypes.SELECT,
        raw: true,
        plain: true,
      },
    );

    return result;
  },
};

export default ContributorQuery;

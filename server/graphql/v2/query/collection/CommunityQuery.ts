import assert from 'assert';

import type Express from 'express';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { isNil } from 'lodash';
import { Sequelize } from 'sequelize';

import { ifStr } from '../../../../lib/utils';
import { Collective, sequelize } from '../../../../models';
import { allowContextPermission, PERMISSION_TYPE } from '../../../common/context-permissions';
import { enforceScope } from '../../../common/scope-check';
import { BadRequest } from '../../../errors';
import { GraphQLAccountCollection } from '../../collection/AccountCollection';
import { AccountTypeToModelMapping, GraphQLAccountType } from '../../enum/AccountType';
import { GraphQLCommunityRelationType } from '../../enum/CommunityRelationType';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import EmailAddress from '../../scalar/EmailAddress';

const DEFAULT_LIMIT = 100;

type CommunitySummaryArgs = {
  limit: number;
  offset: number;
  type?: string[];
  HostCollectiveId?: number;
  CollectiveId?: number;
  email?: string;
  relation?: string;
};
const getHostCommunity = async (replacements: CommunitySummaryArgs) => {
  const isAdmin = 'relation' in replacements && replacements.relation.includes('ADMIN');

  const baseQuery = `
    FROM "CommunityActivitySummary" cas
    INNER JOIN "Collectives" c ON c.id = cas."FromCollectiveId"
    ${ifStr('email' in replacements, `INNER JOIN "Users" u ON u."CollectiveId" = c.id AND u."deletedAt" IS NULL AND u."email" = LOWER(:email)`)}
    ${ifStr(isAdmin, `INNER JOIN "Members" m ON m."CollectiveId" = cas."CollectiveId" AND m."MemberCollectiveId" = "FromCollectiveId" AND m.role = 'ADMIN' AND m."deletedAt" IS NULL`)}
    WHERE
      c."deletedAt" IS NULL
      ${ifStr('HostCollectiveId' in replacements, `AND cas."HostCollectiveId" = :HostCollectiveId`)}
      ${ifStr('CollectiveId' in replacements, `AND cas."CollectiveId" = :CollectiveId`)}
      ${ifStr('type' in replacements, `AND c.type IN (:type)`)}
      ${ifStr('relation' in replacements && replacements.relation.length > 0, `AND cas."relations" @> :relation`)}
    `;

  const nodes = await sequelize.query(
    `SELECT c.* ${baseQuery} GROUP BY cas."FromCollectiveId", c.id ORDER BY c.name LIMIT :limit OFFSET :offset`,
    {
      replacements,
      model: Collective,
      mapToModel: true,
    },
  );

  const totalCount = async () =>
    (sequelize as Sequelize)
      .query<{ totalCount: number }>(`SELECT COUNT(DISTINCT c.id) AS "totalCount" ${baseQuery}`, {
        replacements,
        raw: true,
        type: sequelize.QueryTypes.SELECT,
        plain: true,
      })
      .then(res => res.totalCount || 0);

  return { nodes, totalCount };
};

const CommunityQuery = {
  description: 'Return accounts that have interacted with a given account or host',
  type: new GraphQLNonNull(GraphQLAccountCollection),
  args: {
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'Account filter',
    },
    host: {
      type: GraphQLAccountReferenceInput,
      description: 'Host context filter',
    },
    type: { type: new GraphQLList(GraphQLAccountType) },
    email: {
      type: EmailAddress,
      description: 'Admin only. To filter on the email address of a member, useful to check if a member exists.',
    },
    searchTerm: {
      type: GraphQLString,
    },
    relation: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLCommunityRelationType)),
    },
    limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: DEFAULT_LIMIT },
    offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
  },
  async resolve(_: void, args, req: Express.Request) {
    enforceScope(req, 'host');
    if (isNil(args.limit) || args.limit < 0) {
      args.limit = DEFAULT_LIMIT;
    }
    if (isNil(args.offset) || args.offset < 0) {
      args.offset = 0;
    }
    if (args.limit > DEFAULT_LIMIT && !req.remoteUser?.isRoot()) {
      throw new Error(`Cannot fetch more than ${DEFAULT_LIMIT} members at the same time, please adjust the limit`);
    }

    assert(
      Boolean(args.account) || Boolean(args.host),
      'You must provide either an account or a host to fetch its community',
    );

    const replacements: CommunitySummaryArgs = {
      limit: args.limit,
      offset: args.offset,
    };

    const account = args.account && (await fetchAccountWithReference(args.account, { throwIfMissing: false }));
    const host = args.host && (await fetchAccountWithReference(args.host, { throwIfMissing: false }));
    if (host && account) {
      // TODO: Add exception for accounts that were previously hosted by the host
      assert(
        host.id === account.HostCollectiveId,
        new BadRequest('The account provided is not hosted by the host provided'),
      );
    }
    if (account) {
      assert(
        req.remoteUser?.isAdminOfCollective(host) || req.remoteUser?.isAdminOfCollective(account),
        new BadRequest('Only admins can lookup for members using the "account" argument'),
      );
      replacements.CollectiveId = account.id;
    }
    if (host) {
      assert(
        req.remoteUser?.isAdminOfCollective(host),
        new BadRequest('Only admins can lookup for members using the "host" argument'),
      );
      replacements.HostCollectiveId = host.id;
    }

    if (args.type && args.type.length > 0) {
      replacements.type = args.type.map(value => AccountTypeToModelMapping[value]);
    }
    if (args.relation && args.relation.length > 0) {
      replacements.relation = JSON.stringify(args.relation);
    }
    if (args.email) {
      if (req.remoteUser?.isAdminOfCollective(account) || req.remoteUser?.isAdminOfCollective(host)) {
        replacements.email = args.email.toLowerCase();
      } else {
        throw new BadRequest('Only admins can lookup for members using the "email" argument');
      }
      // TODO: Before returning the result, double check if the remoteUser has access to see the result email
    }

    const data = await getHostCommunity(replacements);
    const ids: number[] = data.nodes.map(c => c.id);
    const permissions = await req.loaders.Collective.canSeePrivateLocation.loadMany(ids);
    ids.forEach((id, i) => {
      if (permissions[i]) {
        allowContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_LOCATION, id);
      }
    });
    return { ...data, limit: args.limit, offset: args.offset };
  },
};

export default CommunityQuery;

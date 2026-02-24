import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { QueryTypes } from 'sequelize';

import sequelize from '../../../lib/sequelize';
import { getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { checkScope } from '../../common/scope-check';
import { Unauthorized } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithContributionsFields, GraphQLAccountWithContributions } from '../interface/AccountWithContributions';
import {
  AccountWithPlatformSubscriptionFields,
  GraphQLAccountWithPlatformSubscription,
} from '../interface/AccountWithPlatformSubscription';

import { GraphQLHost } from './Host';

export const GraphQLOrganization = new GraphQLObjectType({
  name: 'Organization',
  description: 'This represents an Organization account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithContributions, GraphQLAccountWithPlatformSubscription],
  isTypeOf: collective => collective.type === 'ORGANIZATION',
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithContributionsFields,
      ...AccountWithPlatformSubscriptionFields,
      email: {
        type: GraphQLString,
        deprecationReason: '2022-07-18: This field is deprecated and will return null',
        resolve: () => null,
      },
      location: {
        ...AccountFields.location,
        description: `
          Address. This field is public for hosts, otherwise:
            - Users can see the addresses of the collectives they're admin of; if they are not an admin they can only see the country that the org belong to.
            - Hosts can see the address of organizations submitting expenses to their collectives.
        `,
        async resolve(organization, _, req) {
          const location = await req.loaders.Location.byCollectiveId.load(organization.id);
          const canSeeLocation =
            (await organization.isHost()) ||
            (checkScope(req, 'account') &&
              (req.remoteUser?.isAdmin(organization.id) ||
                getContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_LOCATION, organization.id)));

          if (canSeeLocation) {
            return location;
          } else {
            return { country: location?.country };
          }
        },
      },
      host: {
        type: GraphQLHost,
        description: 'If the organization is a host account, this will return the matching Host object',
        resolve(collective) {
          if (collective.hasMoneyManagement) {
            return collective;
          }
        },
      },
      hasMoneyManagement: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'Returns whether the account has money management activated.',
        resolve(collective) {
          return collective.hasMoneyManagement;
        },
      },
      hasHosting: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'Returns whether the account has hosting activated.',
        resolve(collective) {
          return collective.hasHosting;
        },
      },
      canBeVendorOf: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description:
          'Returns whether this organization can be a vendor of the specified host. This checks if the organization only transacted with this host and all its admins are also admins of the host.',
        args: {
          host: {
            type: new GraphQLNonNull(GraphQLAccountReferenceInput),
            description: 'The host account to check against',
          },
        },
        async resolve(organization, args, req) {
          if (!req.remoteUser) {
            throw new Unauthorized('You need to be logged in to check vendor eligibility');
          }

          const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });

          // Query to check if this organization meets the criteria to be a vendor
          const query = `
            WITH hostadmins AS (
              SELECT m."MemberCollectiveId", u."id" as "UserId"
              FROM "Members" m
              INNER JOIN "Users" u ON m."MemberCollectiveId" = u."CollectiveId"
              WHERE m."CollectiveId" = :hostid AND m."deletedAt" IS NULL AND m.role = 'ADMIN'
            ), org AS (
              SELECT c.id, ARRAY_AGG(DISTINCT m."MemberCollectiveId") as "admins", ARRAY_AGG(DISTINCT t."HostCollectiveId") as hosts, c."CreatedByUserId"
              FROM "Collectives" c
              LEFT JOIN "Members" m ON c.id = m."CollectiveId" AND m."deletedAt" IS NULL AND m.role = 'ADMIN'
              LEFT JOIN "Transactions" t ON c.id = t."FromCollectiveId" AND t."deletedAt" IS NULL
              WHERE c."deletedAt" IS NULL
                AND c.id = :orgid
                AND c.type = 'ORGANIZATION'
                AND c."HostCollectiveId" IS NULL
              GROUP BY c.id
            )
            SELECT EXISTS(
              SELECT 1
              FROM "org" o
              WHERE
                (
                  o."admins" <@ ARRAY(SELECT "MemberCollectiveId" FROM hostadmins)
                    OR (
                      o."CreatedByUserId" IN (
                        SELECT "UserId"
                        FROM hostadmins
                      )
                      AND o."admins" = ARRAY[null]::INTEGER[]
                    )
                )
                AND o."hosts" IN (ARRAY[:hostid], ARRAY[null]::INTEGER[])
            ) as "canBeVendor";
          `;

          const result = await sequelize.query(query, {
            replacements: {
              hostid: host.id,
              orgid: organization.id,
            },
            type: QueryTypes.SELECT,
          });

          return result[0]?.canBeVendor || false;
        },
      },
    };
  },
});

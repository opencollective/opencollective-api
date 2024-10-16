import { GraphQLInt, GraphQLObjectType } from 'graphql';
import moment from 'moment';

import models, { sequelize } from '../../../models';
import { GraphQLAccountCollection } from '../collection/AccountCollection';
import { GraphQLGoalType } from '../enum/GoalType';
import { CollectionArgs } from '../interface/Collection';

import { GraphQLAmount } from './Amount';
import GoalTypes from '../../../constants/goal-types';

export const GraphQLGoal = new GraphQLObjectType({
  name: 'Goal',
  fields: () => ({
    type: {
      type: GraphQLGoalType,
      description: 'The type of the goal (per month, per year or all time)',
    },
    amount: {
      type: GraphQLAmount,
      description: 'The amount of the goal',
    },
    progress: {
      type: GraphQLInt,
      description: 'The progress of the goal in percentage',
    },
    contributors: {
      type: GraphQLAccountCollection,
      args: CollectionArgs,
      async resolve(goal, args) {
        const collectiveIdsResult = await sequelize.query(
          `WITH "CollectiveDonations" AS (
            SELECT 
              "Orders"."FromCollectiveId",
              SUM("Transactions".amount) AS total_donated
            FROM "Orders"
            JOIN "Transactions" ON "Transactions"."OrderId" = "Orders".id
            WHERE "Orders"."CollectiveId" = :accountId
              AND (
                ("Orders".status = 'ACTIVE' AND "Orders".interval IN ('month', 'year'))
                OR ("Orders".status = 'PAID' ${[GoalTypes.MONTHLY_BUDGET, GoalTypes.YEARLY_BUDGET].includes(goal.type) ? 'AND "Orders"."createdAt" >= :dateFrom' : ''})
              )
              AND "Transactions".type = 'CREDIT'
              AND "Transactions"."CollectiveId" = :accountId
              AND "Transactions"."FromCollectiveId" = "Orders"."FromCollectiveId"
              AND "Transactions"."isRefund" = FALSE
              AND "Transactions"."RefundTransactionId" IS NULL
              AND "Transactions"."deletedAt" IS NULL
              AND "Orders"."deletedAt" IS NULL
            GROUP BY "Orders"."FromCollectiveId"
          )
          SELECT "Collectives".id
          FROM "Collectives"
          JOIN "CollectiveDonations" ON "Collectives".id = "CollectiveDonations"."FromCollectiveId"
          WHERE "Collectives"."deletedAt" IS NULL
          ORDER BY "CollectiveDonations".total_donated DESC;
          `,
          {
            replacements: {
              accountId: goal.accountId,
              dateFrom: [GoalTypes.MONTHLY_BUDGET, GoalTypes.YEARLY_BUDGET].includes(goal.type)
                ? moment().utc().subtract(1, 'year').toDate().toISOString()
                : undefined,
            },
            type: sequelize.QueryTypes.SELECT,
          },
        );

        const collectiveIds = collectiveIdsResult.map(result => result.id);

        const collectives = await models.Collective.findAll({
          where: {
            id: collectiveIds,
          },
          order: [['id', 'DESC']], // To maintain the order of total donations
          offset: args.offset,
          limit: args.limit,
        });

        return {
          totalCount: collectiveIdsResult.length,
          nodes: collectives,
          limit: args.limit,
          offset: args.offset,
        };
      },
    },
  }),
});

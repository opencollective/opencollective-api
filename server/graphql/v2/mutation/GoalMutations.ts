import { GraphQLNonNull } from 'graphql';
import { cloneDeep, set } from 'lodash';

import activities from '../../../constants/activities';
import models, { sequelize } from '../../../models';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { Forbidden, Unauthorized } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLGoalInput } from '../input/GoalInput';
import { GraphQLGoal } from '../object/Goal';

const goalMutations = {
  setGoal: {
    type: GraphQLGoal,
    description: 'Set a goal for your account.',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      },
      goal: {
        type: GraphQLGoalInput,
        description: 'The goal to set for the account. Setting goal to undefined or null will remove any current goal.',
      },
    },
    async resolve(_: void, args: Record<string, unknown>, req: Express.Request): Promise<typeof GraphQLGoal> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      return sequelize.transaction(async transaction => {
        const account = await fetchAccountWithReference(args.account, {
          throwIfMissing: true,
          lock: true,
          dbTransaction: transaction,
        });

        if (!req.remoteUser.isAdminOfCollective(account)) {
          throw new Forbidden();
        }

        checkRemoteUserCanUseAccount(req);

        const settings = account.settings ? cloneDeep(account.settings) : {};
        set(settings, 'goal', args.goal);
        // Remove legacy goals
        set(settings, 'goals', undefined);
        const previousData = {
          settings: { goal: account.settings?.goal, ...(account.settings?.goals && { goals: account.settings.goals }) },
        };
        const updatedAccount = await account.update({ settings }, { transaction });
        await models.Activity.create(
          {
            type: activities.COLLECTIVE_EDITED,
            UserId: req.remoteUser.id,
            UserTokenId: req.userToken?.id,
            CollectiveId: account.id,
            FromCollectiveId: account.id,
            HostCollectiveId: account.approvedAt ? account.HostCollectiveId : null,
            data: {
              previousData,
              newData: { settings: { goal: args.goal } },
            },
          },
          { transaction },
        );
        return updatedAccount.settings.goal;
      });
    },
  },
};

export default goalMutations;

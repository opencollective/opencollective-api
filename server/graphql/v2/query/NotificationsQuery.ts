import { GraphQLList, GraphQLNonNull } from 'graphql';

import models from '../../../models';
import { Forbidden } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { Notification } from '../object/Notification';

const NotificationsQuery = {
  type: new GraphQLList(Notification),
  description: '[AUTHENTICATED] Returns user notifications',
  args: {
    individual: {
      type: new GraphQLNonNull(AccountReferenceInput),
      description: 'A reference to an account (usually Individual). Will return notifications set by this user.',
    },
    account: {
      type: AccountReferenceInput,
      description:
        'A reference to an account (usually Collective, Fund or Organization). Will return notifications related to specific account.',
    },
  },
  async resolve(_, args, req) {
    if (!req.remoteUser) {
      throw new Forbidden('You need to be logged in to query for notifications');
    }

    const userCollective = await fetchAccountWithReference(args.individual, { throwIfMissing: true });
    const user = await userCollective.getUser();
    if (!user) {
      throw new Error('Individual must be an User account');
    } else if (user.id !== req.remoteUser.id) {
      throw new Forbidden('You can only query for your own Notifications');
    }

    const where = {
      UserId: user.id,
    };

    if (args.account) {
      where['CollectiveId'] = args.account.legacyId || idDecode(args.account.id, IDENTIFIER_TYPES.ACCOUNT);
    }

    return models.Notification.findAll({
      where,
    });
  },
};

export default NotificationsQuery;

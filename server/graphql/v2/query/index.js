import models from '../../../models';
import { Account } from '../interface/Account';

import HostsCollectionQuery from './collection/HostsCollectionQuery';
import AccountQuery from './AccountQuery';
import CollectiveQuery from './CollectiveQuery';
import ConversationQuery from './ConversationQuery';
import ExpenseQuery from './ExpenseQuery';
import HostQuery from './HostQuery';
import IndividualQuery from './IndividualQuery';

const query = {
  account: AccountQuery,
  collective: CollectiveQuery,
  host: HostQuery,
  individual: IndividualQuery,
  conversation: ConversationQuery,
  expense: ExpenseQuery,
  hosts: HostsCollectionQuery,
  // transaction: TransactionQuery,
  // transactions: TransactionsQuery,
  loggedInAccount: {
    type: Account,
    resolve(_, args, req) {
      if (!req.remoteUser) {
        return null;
      } else {
        return models.Collective.findByPk(req.remoteUser.CollectiveId);
      }
    },
  },
};

export default query;

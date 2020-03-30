import models from '../../../models';
import { Account } from '../interface/Account';

import AccountQuery from './AccountQuery';
import CollectiveQuery from './CollectiveQuery';
import ConversationQuery from './ConversationQuery';
import ExpenseQuery from './ExpenseQuery';

// import TransactionQuery from './TransactionQuery';
// import TransactionsQuery from './TransactionsQuery';

const query = {
  account: AccountQuery,
  collective: CollectiveQuery,
  conversation: ConversationQuery,
  expense: ExpenseQuery,
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

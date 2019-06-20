import AccountQuery from './AccountQuery';
import CollectiveQuery from './CollectiveQuery';

// import TransactionQuery from './TransactionQuery';
// import TransactionsQuery from './TransactionsQuery';

import { Account } from '../interface/Account';

const query = {
  account: AccountQuery,
  collective: CollectiveQuery,
  // transaction: TransactionQuery,
  // transactions: TransactionsQuery,
  loggedInAccount: {
    type: Account,
    resolve(_, args, req) {
      return req.loaders.Collective.byId.load(req.remoteUser.CollectiveId);
    },
  },
};

export default query;

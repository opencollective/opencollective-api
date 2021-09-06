import models from '../../../models';
import { Account } from '../interface/Account';

import AccountsQuery from './collection/AccountsQuery';
import ExpensesCollectionQuery from './collection/ExpensesCollectionQuery';
import HostsCollectionQuery from './collection/HostsCollectionQuery';
import OrdersCollectionQuery from './collection/OrdersCollectionQuery';
import TransactionsCollectionQuery from './collection/TransactionsCollectionQuery';
import AccountQuery from './AccountQuery';
import CollectiveQuery from './CollectiveQuery';
import ConversationQuery from './ConversationQuery';
import ExpenseQuery from './ExpenseQuery';
import HostQuery from './HostQuery';
import IndividualQuery from './IndividualQuery';
import MemberInvitationsQuery from './MemberInvitationsQuery';
import OrderQuery from './OrderQuery';
import PaypalPlanQuery from './PaypalPlanQuery';
import TierQuery from './TierQuery';
import UpdateQuery from './UpdateQuery';

const query = {
  account: AccountQuery,
  accounts: AccountsQuery,
  collective: CollectiveQuery,
  host: HostQuery,
  individual: IndividualQuery,
  conversation: ConversationQuery,
  expenses: ExpensesCollectionQuery,
  expense: ExpenseQuery,
  hosts: HostsCollectionQuery,
  memberInvitations: MemberInvitationsQuery,
  order: OrderQuery,
  orders: OrdersCollectionQuery,
  tier: TierQuery,
  // transaction: TransactionQuery,
  transactions: TransactionsCollectionQuery,
  update: UpdateQuery,
  paypalPlan: PaypalPlanQuery,
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

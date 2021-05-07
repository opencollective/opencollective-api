import models from '../../../models';
import { Account } from '../interface/Account';

import HostsCollectionQuery from './collection/HostsCollectionQuery';
import AccountQuery from './AccountQuery';
import CollectiveQuery from './CollectiveQuery';
import ConversationQuery from './ConversationQuery';
import ExpenseQuery from './ExpenseQuery';
import ExpensesQuery from './ExpensesQuery';
import HostQuery from './HostQuery';
import IndividualQuery from './IndividualQuery';
import MemberInvitationsQuery from './MemberInvitationsQuery';
import OrderQuery from './OrderQuery';
import OrdersQuery from './OrdersQuery';
import PaypalPlanQuery from './PaypalPlanQuery';
import TierQuery from './TierQuery';
import TransactionsQuery from './TransactionsQuery';
import UpdateQuery from './UpdateQuery';

const query = {
  account: AccountQuery,
  collective: CollectiveQuery,
  host: HostQuery,
  individual: IndividualQuery,
  conversation: ConversationQuery,
  expenses: ExpensesQuery,
  expense: ExpenseQuery,
  hosts: HostsCollectionQuery,
  memberInvitations: MemberInvitationsQuery,
  order: OrderQuery,
  orders: OrdersQuery,
  tier: TierQuery,
  // transaction: TransactionQuery,
  transactions: TransactionsQuery,
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

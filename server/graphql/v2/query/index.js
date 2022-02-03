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
import EventQuery from './EventQuery';
import ExpenseQuery from './ExpenseQuery';
import FundQuery from './FundQuery';
import HostQuery from './HostQuery';
import IndividualQuery from './IndividualQuery';
import MemberInvitationsQuery from './MemberInvitationsQuery';
import OrderQuery from './OrderQuery';
import OrganizationQuery from './OrganizationQuery';
import PaypalPlanQuery from './PaypalPlanQuery';
import ProjectQuery from './ProjectQuery';
import TierQuery from './TierQuery';
import UpdateQuery from './UpdateQuery';

const query = {
  account: AccountQuery,
  accounts: AccountsQuery,
  collective: CollectiveQuery,
  conversation: ConversationQuery,
  event: EventQuery,
  expense: ExpenseQuery,
  expenses: ExpensesCollectionQuery,
  fund: FundQuery,
  host: HostQuery,
  hosts: HostsCollectionQuery,
  individual: IndividualQuery,
  memberInvitations: MemberInvitationsQuery,
  order: OrderQuery,
  orders: OrdersCollectionQuery,
  organization: OrganizationQuery,
  project: ProjectQuery,
  tier: TierQuery,
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

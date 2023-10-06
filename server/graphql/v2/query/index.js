import { GraphQLIndividual } from '../object/Individual';

import AccountsCollectionQuery from './collection/AccountsCollectionQuery';
import ActivitiesCollectionQuery from './collection/ActivitiesCollectionQuery';
import ExpensesCollectionQuery from './collection/ExpensesCollectionQuery';
import HostsCollectionQuery from './collection/HostsCollectionQuery';
import getOrdersCollectionQuery from './collection/OrdersCollectionQuery';
import TagStatsCollectionQuery from './collection/TagStatsCollectionQuery';
import TransactionsCollectionQuery from './collection/TransactionsCollectionQuery';
import UpdatesCollectionQuery from './collection/UpdatesCollectionQuery';
import VirtualCardRequestsCollectionQuery from './collection/VirtualCardRequestsCollectionQuery';
import AccountQuery from './AccountQuery';
import ApplicationQuery from './ApplicationQuery';
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
import PersonalTokenQuery from './PersonalTokenQuery';
import ProjectQuery from './ProjectQuery';
import TierQuery from './TierQuery';
import TransactionQuery from './TransactionQuery';
import UpdateQuery from './UpdateQuery';
import VirtualCardQuery from './VirtualCardQuery';
import VirtualCardRequestQuery from './VirtualCardRequestQuery';

const query = {
  account: AccountQuery,
  accounts: AccountsCollectionQuery,
  activities: ActivitiesCollectionQuery,
  application: ApplicationQuery,
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
  orders: getOrdersCollectionQuery(),
  organization: OrganizationQuery,
  project: ProjectQuery,
  tagStats: TagStatsCollectionQuery,
  tier: TierQuery,
  transaction: TransactionQuery,
  transactions: TransactionsCollectionQuery,
  update: UpdateQuery,
  updates: UpdatesCollectionQuery,
  paypalPlan: PaypalPlanQuery,
  personalToken: PersonalTokenQuery,
  virtualCard: VirtualCardQuery,
  virtualCardRequest: VirtualCardRequestQuery,
  virtualCardRequests: VirtualCardRequestsCollectionQuery,
  loggedInAccount: {
    type: GraphQLIndividual,
    resolve(_, args, req) {
      if (!req.remoteUser) {
        return null;
      } else {
        return req.loaders.Collective.byId.load(req.remoteUser.CollectiveId);
      }
    },
  },
  me: {
    type: GraphQLIndividual,
    resolve(_, args, req) {
      if (!req.remoteUser) {
        return null;
      } else {
        return req.loaders.Collective.byId.load(req.remoteUser.CollectiveId);
      }
    },
  },
};

export default query;

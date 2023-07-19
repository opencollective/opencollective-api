import { GraphQLIndividual } from '../object/Individual.js';

import AccountsCollectionQuery from './collection/AccountsCollectionQuery.js';
import ActivitiesCollectionQuery from './collection/ActivitiesCollectionQuery.js';
import ExpensesCollectionQuery from './collection/ExpensesCollectionQuery.js';
import HostsCollectionQuery from './collection/HostsCollectionQuery.js';
import getOrdersCollectionQuery from './collection/OrdersCollectionQuery.js';
import TagStatsCollectionQuery from './collection/TagStatsCollectionQuery.js';
import TransactionsCollectionQuery from './collection/TransactionsCollectionQuery.js';
import UpdatesCollectionQuery from './collection/UpdatesCollectionQuery.js';
import VirtualCardRequestsCollectionQuery from './collection/VirtualCardRequestsCollectionQuery.js';
import AccountQuery from './AccountQuery.js';
import ApplicationQuery from './ApplicationQuery.js';
import CollectiveQuery from './CollectiveQuery.js';
import ConversationQuery from './ConversationQuery.js';
import EventQuery from './EventQuery.js';
import ExpenseQuery from './ExpenseQuery.js';
import FundQuery from './FundQuery.js';
import HostQuery from './HostQuery.js';
import IndividualQuery from './IndividualQuery.js';
import MemberInvitationsQuery from './MemberInvitationsQuery.js';
import OrderQuery from './OrderQuery.js';
import OrganizationQuery from './OrganizationQuery.js';
import PaypalPlanQuery from './PaypalPlanQuery.js';
import PersonalTokenQuery from './PersonalTokenQuery.js';
import ProjectQuery from './ProjectQuery.js';
import TierQuery from './TierQuery.js';
import TransactionQuery from './TransactionQuery.js';
import UpdateQuery from './UpdateQuery.js';
import VirtualCardQuery from './VirtualCardQuery.js';
import VirtualCardRequestQuery from './VirtualCardRequestQuery.js';

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

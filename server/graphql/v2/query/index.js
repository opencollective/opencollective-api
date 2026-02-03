import { GraphQLIndividual } from '../object/Individual';

import AccountsCollectionQuery from './collection/AccountsCollectionQuery';
import ActivitiesCollectionQuery from './collection/ActivitiesCollectionQuery';
import CommunityQuery from './collection/CommunityQuery';
import ExpensesCollectionQuery from './collection/ExpensesCollectionQuery';
import ExpenseTagStatsCollectionQuery from './collection/ExpenseTagStatsCollectionQuery';
import ExportRequestsCollectionQuery from './collection/ExportRequestsCollectionQuery';
import HostsCollectionQuery from './collection/HostsCollectionQuery';
import getOrdersCollectionQuery from './collection/OrdersCollectionQuery';
import TagStatsCollectionQuery from './collection/TagStatsCollectionQuery';
import TransactionGroupCollectionQuery from './collection/TransactionGroupCollectionQuery';
import TransactionsCollectionQuery from './collection/TransactionsCollectionQuery';
import UpdatesCollectionQuery from './collection/UpdatesCollectionQuery';
import VirtualCardRequestsCollectionQuery from './collection/VirtualCardRequestsCollectionQuery';
import AccountQuery from './AccountQuery';
import ApplicationQuery from './ApplicationQuery';
import CollectiveQuery from './CollectiveQuery';
import ConversationQuery from './ConversationQuery';
import CurrencyExchangeRateQuery from './CurrencyExchangeRateQuery';
import EventQuery from './EventQuery';
import ExpenseQuery from './ExpenseQuery';
import FundQuery from './FundQuery';
import HostApplicationQuery from './HostApplicationQuery';
import HostQuery from './HostQuery';
import IndividualQuery from './IndividualQuery';
import MemberInvitationsQuery from './MemberInvitationsQuery';
import OffPlatformTransactionsInstitutionsQuery from './OffPlatformTransactionsInstitutionsQuery';
import OrderQuery from './OrderQuery';
import OrganizationQuery from './OrganizationQuery';
import PaypalPlanQuery from './PaypalPlanQuery';
import PersonalTokenQuery from './PersonalTokenQuery';
import platformSubscriptionTiers from './PlatformSubscriptionTiers';
import ProjectQuery from './ProjectQuery';
import SearchQuery from './SearchQuery';
import TierQuery from './TierQuery';
import TransactionGroupQuery from './TransactionGroupQuery';
import TransactionQuery from './TransactionQuery';
import TransactionsImportQuery from './TransactionsImport';
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
  community: CommunityQuery,
  currencyExchangeRate: CurrencyExchangeRateQuery,
  event: EventQuery,
  expense: ExpenseQuery,
  expenses: ExpensesCollectionQuery,
  expenseTagStats: ExpenseTagStatsCollectionQuery,
  exportRequests: ExportRequestsCollectionQuery,
  fund: FundQuery,
  host: HostQuery,
  hosts: HostsCollectionQuery,
  individual: IndividualQuery,
  memberInvitations: MemberInvitationsQuery,
  order: OrderQuery,
  orders: getOrdersCollectionQuery(),
  organization: OrganizationQuery,
  project: ProjectQuery,
  search: SearchQuery,
  tagStats: TagStatsCollectionQuery,
  tier: TierQuery,
  transaction: TransactionQuery,
  transactions: TransactionsCollectionQuery,
  transactionGroup: TransactionGroupQuery,
  transactionGroups: TransactionGroupCollectionQuery,
  transactionsImport: TransactionsImportQuery,
  update: UpdateQuery,
  updates: UpdatesCollectionQuery,
  paypalPlan: PaypalPlanQuery,
  personalToken: PersonalTokenQuery,
  virtualCard: VirtualCardQuery,
  virtualCardRequest: VirtualCardRequestQuery,
  virtualCardRequests: VirtualCardRequestsCollectionQuery,
  hostApplication: HostApplicationQuery,
  offPlatformTransactionsInstitutions: OffPlatformTransactionsInstitutionsQuery,
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
  platformSubscriptionTiers,
};

export default query;

import sequelize, { Op } from '../lib/sequelize';

import AccountingCategory from './AccountingCategory';
import Activity from './Activity';
import Agreement from './Agreement';
import Application from './Application';
import Collective from './Collective';
import Comment from './Comment';
import ConnectedAccount from './ConnectedAccount';
import Conversation from './Conversation';
import ConversationFollower from './ConversationFollower';
import CurrencyExchangeRate from './CurrencyExchangeRate';
import EmojiReaction from './EmojiReaction';
import Expense from './Expense';
import ExpenseAttachedFile from './ExpenseAttachedFile';
import ExpenseItem from './ExpenseItem';
import HostApplication from './HostApplication';
import LegalDocument from './LegalDocument';
import Location from './Location';
import Member from './Member';
import MemberInvitation from './MemberInvitation';
import MigrationLog from './MigrationLog';
import Notification from './Notification';
import OAuthAuthorizationCode from './OAuthAuthorizationCode';
import Order from './Order';
import PaymentMethod from './PaymentMethod';
import PayoutMethod from './PayoutMethod';
import PaypalPlan from './PaypalPlan';
import PaypalProduct from './PaypalProduct';
import PersonalToken from './PersonalToken';
import RecurringExpense from './RecurringExpense';
import RequiredLegalDocument from './RequiredLegalDocument';
import SocialLink from './SocialLink';
import Subscription from './Subscription';
import SuspendedAsset from './SuspendedAsset';
import Tier from './Tier';
import Transaction from './Transaction';
import TransactionSettlement from './TransactionSettlement';
import TransactionsImport from './TransactionsImport';
import TransactionsImportRow from './TransactionsImportRow';
import Update from './Update';
import UploadedFile from './UploadedFile';
import User from './User';
import UserToken from './UserToken';
import UserTwoFactorMethod from './UserTwoFactorMethod';
import VirtualCard from './VirtualCard';
import VirtualCardRequest from './VirtualCardRequest';

/**
 * Models.
 */
const models = {
  AccountingCategory,
  Activity,
  Agreement,
  Application,
  Collective,
  Comment,
  ConnectedAccount,
  Conversation,
  ConversationFollower,
  CurrencyExchangeRate,
  EmojiReaction,
  Expense,
  ExpenseAttachedFile,
  ExpenseItem,
  HostApplication,
  LegalDocument,
  Location,
  Member,
  MemberInvitation,
  MigrationLog,
  Notification,
  OAuthAuthorizationCode,
  Order,
  PaymentMethod,
  PayoutMethod,
  PaypalPlan,
  PaypalProduct,
  PersonalToken,
  RecurringExpense,
  RequiredLegalDocument,
  SocialLink,
  Subscription,
  SuspendedAsset,
  Tier,
  Transaction,
  TransactionSettlement,
  TransactionsImport,
  Update,
  UploadedFile,
  User,
  UserToken,
  UserTwoFactorMethod,
  VirtualCard,
  VirtualCardRequest,
} as const;

/**
 * Relationships
 */

// AccountingCategory
AccountingCategory.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
AccountingCategory.hasMany(Expense, { foreignKey: 'AccountingCategoryId', as: 'expenses' });
AccountingCategory.hasMany(Order, { foreignKey: 'AccountingCategoryId', as: 'orders' });

// Activity.
Activity.belongsTo(Collective);
Activity.belongsTo(Expense);
Activity.belongsTo(Transaction);
Activity.belongsTo(User);

// Applications
Application.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
Application.belongsTo(User, { foreignKey: 'CreatedByUserId', as: 'createdByUser' });
Application.hasMany(UserToken, { foreignKey: 'ApplicationId', as: 'userTokens' });

// Agreement
Agreement.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'Collective' });
Agreement.belongsTo(Collective, { foreignKey: 'HostCollectiveId', as: 'Host' });
Agreement.belongsTo(User, { foreignKey: 'UserId', as: 'User' });

// Collective
Collective.belongsTo(Collective, { as: 'HostCollective' });
Collective.belongsTo(Collective, { foreignKey: 'HostCollectiveId', as: 'host' });
Collective.belongsTo(Collective, { foreignKey: 'ParentCollectiveId', as: 'parent' });
Collective.belongsToMany(Collective, {
  as: 'memberCollectives',
  through: { model: Member, unique: false, foreignKey: 'MemberCollectiveId' } as any,
});
Collective.belongsToMany(Collective, {
  through: { model: Member, unique: false, foreignKey: 'CollectiveId' } as any,
  as: 'memberOfCollectives',
});
Collective.hasMany(AccountingCategory, { foreignKey: 'CollectiveId', as: 'accountingCategories' });
Collective.hasMany(Activity);
Collective.hasMany(Collective, { as: 'hostedCollectives', foreignKey: 'HostCollectiveId' });
Collective.hasMany(Collective, { foreignKey: 'ParentCollectiveId', as: 'children' });
Collective.hasMany(ConnectedAccount);
Collective.hasMany(Expense, { foreignKey: 'CollectiveId', as: 'expenses' });
Collective.hasMany(Expense, { foreignKey: 'FromCollectiveId', as: 'submittedExpenses' });
Collective.hasMany(HostApplication, { foreignKey: 'CollectiveId', as: 'hostApplications' });
Collective.hasMany(LegalDocument);
Collective.hasMany(LegalDocument, { foreignKey: 'CollectiveId', as: 'legalDocuments' });
Collective.hasMany(Member, { foreignKey: 'CollectiveId', as: 'members' });
Collective.hasMany(Member, { foreignKey: 'CollectiveId', as: 'adminMembers', scope: { role: 'ADMIN' } });
Collective.hasMany(Member, { foreignKey: 'MemberCollectiveId', as: 'memberships' });
Collective.hasMany(Notification);
Collective.hasMany(Order, { foreignKey: 'CollectiveId', as: 'orders' });
Collective.hasMany(PayoutMethod);
Collective.hasMany(RequiredLegalDocument, { foreignKey: 'HostCollectiveId' });
Collective.hasMany(SocialLink, { foreignKey: 'CollectiveId', as: 'socialLinks' });
Collective.hasMany(Tier, { as: 'tiers' });
Collective.hasMany(Transaction, { foreignKey: 'CollectiveId' });
Collective.hasMany(VirtualCard, { foreignKey: 'CollectiveId', as: 'virtualCardCollectives' });
Collective.hasMany(VirtualCard, { foreignKey: 'HostCollectiveId', as: 'virtualCards' });
Collective.hasOne(Location, { foreignKey: 'CollectiveId', as: 'location' });
Collective.hasOne(User, { as: 'user', foreignKey: 'CollectiveId', constraints: false });

// Comment
Comment.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
Comment.belongsTo(Collective, { foreignKey: 'FromCollectiveId', as: 'fromCollective' });
Comment.belongsTo(Expense, { foreignKey: 'ExpenseId', as: 'expense' });
Comment.belongsTo(Update, { foreignKey: 'UpdateId', as: 'update' });
Comment.belongsTo(User, { foreignKey: 'CreatedByUserId', as: 'user' });

// ConnectedAccount
ConnectedAccount.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });

// Conversations
Conversation.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
Conversation.belongsTo(Collective, { foreignKey: 'FromCollectiveId', as: 'fromCollective' });

// ConversationFollower
ConversationFollower.belongsTo(Conversation, { foreignKey: 'ConversationId', as: 'conversation' });
ConversationFollower.belongsTo(User, { foreignKey: 'UserId', as: 'user' });

// EmojiReaction
EmojiReaction.belongsTo(Comment);
EmojiReaction.belongsTo(User);

// Expense
Expense.belongsTo(AccountingCategory, { as: 'accountingCategory', foreignKey: 'AccountingCategoryId' });
Expense.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
Expense.belongsTo(Collective, { foreignKey: 'FromCollectiveId', as: 'fromCollective' });
Expense.belongsTo(Collective, { foreignKey: 'HostCollectiveId', as: 'host' });
Expense.belongsTo(PayoutMethod);
Expense.belongsTo(PaymentMethod, { foreignKey: 'PaymentMethodId', as: 'paymentMethod' });
Expense.belongsTo(RecurringExpense, { foreignKey: 'RecurringExpenseId', as: 'recurringExpense' });
Expense.belongsTo(User);
Expense.belongsTo(VirtualCard, { foreignKey: 'VirtualCardId', as: 'virtualCard' });
Expense.hasMany(Activity, { as: 'activities' });
Expense.hasMany(Comment, { as: 'comments' });
Expense.hasMany(ExpenseAttachedFile, { as: 'attachedFiles' });
Expense.hasMany(ExpenseItem, { as: 'items' });
Expense.hasMany(Transaction);

// ExpenseAttachedFile
ExpenseAttachedFile.belongsTo(Expense);

// ExpenseItem
ExpenseItem.belongsTo(Expense);

// HostApplication
HostApplication.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });

// LegalDocument
LegalDocument.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });

// Location
Location.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });

// Members
Member.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
Member.belongsTo(Collective, { foreignKey: 'MemberCollectiveId', as: 'memberCollective' });
Member.belongsTo(Tier);
Member.belongsTo(User, { foreignKey: 'CreatedByUserId', as: 'createdByUser' });

// MemberInvitation
MemberInvitation.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
MemberInvitation.belongsTo(Collective, { foreignKey: 'MemberCollectiveId', as: 'memberCollective' });
MemberInvitation.belongsTo(Tier);
MemberInvitation.belongsTo(User, { foreignKey: 'CreatedByUserId', as: 'createdByUser' });

// Notification.
Notification.belongsTo(Collective);
Notification.belongsTo(User);

// OAuthAuthorizationCode
OAuthAuthorizationCode.belongsTo(Application, { foreignKey: 'ApplicationId', as: 'application' });
OAuthAuthorizationCode.belongsTo(User, { foreignKey: 'UserId', as: 'user' });

// Order.
Order.belongsTo(AccountingCategory, { as: 'accountingCategory', foreignKey: 'AccountingCategoryId' });
Order.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
Order.belongsTo(Collective, { foreignKey: 'FromCollectiveId', as: 'fromCollective' });
Order.belongsTo(PaymentMethod, { foreignKey: 'PaymentMethodId', as: 'paymentMethod' });
Order.belongsTo(Subscription); // adds SubscriptionId to the Orders table
Order.belongsTo(Tier);
Order.belongsTo(User, { foreignKey: 'CreatedByUserId', as: 'createdByUser' });
Order.hasMany(Transaction);

// PaymentMethod
PaymentMethod.belongsTo(Collective);
PaymentMethod.belongsTo(PaymentMethod, { as: 'sourcePaymentMethod', foreignKey: 'SourcePaymentMethodId' });
PaymentMethod.hasMany(Expense);
PaymentMethod.hasMany(Order);
PaymentMethod.hasMany(Transaction);

// Payout method
PayoutMethod.belongsTo(Collective);
PayoutMethod.belongsTo(User, { foreignKey: 'CreatedByUserId', as: 'createdByUser' });

// PaypalPlan
PaypalPlan.belongsTo(PaypalProduct, { foreignKey: 'ProductId', as: 'product' });
PaypalProduct.hasMany(PaypalPlan, { foreignKey: 'ProductId', as: 'plans' });

// PersonalToken
PersonalToken.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
PersonalToken.belongsTo(User, { foreignKey: 'UserId', as: 'user' });

// Recurring Expenses
RecurringExpense.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
RecurringExpense.belongsTo(Collective, { foreignKey: 'FromCollectiveId', as: 'fromCollective' });
RecurringExpense.hasMany(Expense, { as: 'expenses' });

// RequiredLegalDocument
RequiredLegalDocument.belongsTo(Collective, { foreignKey: 'HostCollectiveId', as: 'hostCollective' });

// SocialLink
SocialLink.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });

// Subscription
Subscription.hasOne(Order);

// Tier
Tier.belongsTo(Collective);
Tier.hasMany(Order);

// Transaction
Transaction.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
Transaction.belongsTo(Collective, { foreignKey: 'FromCollectiveId', as: 'fromCollective' });
Transaction.belongsTo(Collective, { foreignKey: 'HostCollectiveId', as: 'host' });
Transaction.belongsTo(Collective, { foreignKey: 'UsingGiftCardFromCollectiveId', as: 'usingGiftCardFromCollective' });
Transaction.belongsTo(Expense);
Transaction.belongsTo(Order);
Transaction.belongsTo(PaymentMethod);
Transaction.belongsTo(PayoutMethod);
Transaction.belongsTo(User, { foreignKey: 'CreatedByUserId', as: 'createdByUser' });

// TransactionSettlement
TransactionSettlement.belongsTo(Expense);

// TransactionsImport
TransactionsImport.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
TransactionsImport.hasMany(TransactionsImportRow, { foreignKey: 'TransactionsImportId', as: 'importRows' });

// TransactionImportRow
TransactionsImportRow.belongsTo(TransactionsImport, { foreignKey: 'TransactionsImportId', as: 'import' });

// Update
Update.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
Update.belongsTo(Collective, { foreignKey: 'FromCollectiveId', as: 'fromCollective' });
Update.belongsTo(Tier, { foreignKey: 'TierId', as: 'tier' });
Update.belongsTo(User, { foreignKey: 'LastEditedByUserId', as: 'user' });

// Uploaded files
UploadedFile.belongsTo(User, { foreignKey: 'CreatedByUserId', as: 'user' });

// User
User.belongsTo(Collective, { as: 'collective', foreignKey: 'CollectiveId', constraints: false });
User.hasMany(Activity);
User.hasMany(ConnectedAccount, { foreignKey: 'CreatedByUserId' });
User.hasMany(Member, { foreignKey: 'CreatedByUserId' });
User.hasMany(Notification);
User.hasMany(Order, { foreignKey: 'CreatedByUserId', as: 'orders' });
User.hasMany(PaymentMethod, { foreignKey: 'CreatedByUserId' });
User.hasMany(Transaction, { foreignKey: 'CreatedByUserId', as: 'transactions' });
User.hasMany(UserToken, { foreignKey: 'UserId' });
User.hasMany(UserTwoFactorMethod);

// UserToken
UserToken.belongsTo(Application, { foreignKey: 'ApplicationId', as: 'client' });
UserToken.belongsTo(User, { foreignKey: 'UserId', as: 'user' });

// UserTwoFactorMethod
UserTwoFactorMethod.belongsTo(User);

// VirtualCard
VirtualCard.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
VirtualCard.belongsTo(Collective, { foreignKey: 'HostCollectiveId', as: 'host' });
VirtualCard.belongsTo(User, { foreignKey: 'UserId', as: 'user' });
VirtualCard.belongsTo(VirtualCardRequest, { foreignKey: 'VirtualCardRequestId', as: 'virtualCardRequest' });
VirtualCard.hasMany(Expense, { foreignKey: 'VirtualCardId', as: 'expenses' });

// VirtualCardRequest
VirtualCardRequest.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'collective' });
VirtualCardRequest.belongsTo(Collective, { foreignKey: 'HostCollectiveId', as: 'host' });
VirtualCardRequest.belongsTo(User, { foreignKey: 'UserId', as: 'user' });
VirtualCardRequest.belongsTo(VirtualCard, { foreignKey: 'VirtualCardId', as: 'virtualCard' });

export default models;

export { sequelize, Op };

// ts-unused-exports:disable-next-line
export {
  AccountingCategory,
  Activity,
  Agreement,
  Application,
  Collective,
  Comment,
  ConnectedAccount,
  Conversation,
  ConversationFollower,
  CurrencyExchangeRate,
  EmojiReaction,
  Expense,
  ExpenseAttachedFile,
  ExpenseItem,
  HostApplication,
  LegalDocument,
  Location,
  Member,
  MemberInvitation,
  MigrationLog,
  Notification,
  OAuthAuthorizationCode,
  Order,
  PaymentMethod,
  PayoutMethod,
  PaypalPlan,
  PaypalProduct,
  PersonalToken,
  RecurringExpense,
  RequiredLegalDocument,
  SocialLink,
  Subscription,
  SuspendedAsset,
  Tier,
  Transaction,
  TransactionsImport,
  TransactionsImportRow,
  TransactionSettlement,
  Update,
  UploadedFile,
  User,
  UserToken,
  UserTwoFactorMethod,
  VirtualCard,
  VirtualCardRequest,
};

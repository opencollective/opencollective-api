import sequelize, { Op } from '../lib/sequelize';

import AccountingCategory from './AccountingCategory';
import { Activity } from './Activity';
import Agreement from './Agreement';
import Application from './Application';
import Collective from './Collective';
import Comment from './Comment';
import { ConnectedAccount } from './ConnectedAccount';
import Conversation from './Conversation';
import ConversationFollower from './ConversationFollower';
import { CurrencyExchangeRate } from './CurrencyExchangeRate';
import EmojiReaction from './EmojiReaction';
import Expense from './Expense';
import { ExpenseAttachedFile } from './ExpenseAttachedFile';
import { ExpenseItem } from './ExpenseItem';
import { HostApplication } from './HostApplication';
import LegalDocument from './LegalDocument';
import Location from './Location';
import Member from './Member';
import MemberInvitation from './MemberInvitation';
import MigrationLog from './MigrationLog';
import { Notification } from './Notification';
import OAuthAuthorizationCode from './OAuthAuthorizationCode';
import Order from './Order';
import PaymentMethod from './PaymentMethod';
import PayoutMethod from './PayoutMethod';
import PaypalPlan from './PaypalPlan';
import PaypalProduct from './PaypalProduct';
import PersonalToken from './PersonalToken';
import { RecurringExpense } from './RecurringExpense';
import RequiredLegalDocument from './RequiredLegalDocument';
import SocialLink from './SocialLink';
import Subscription from './Subscription';
import SuspendedAsset from './SuspendedAsset';
import Tier from './Tier';
import Transaction from './Transaction';
import TransactionSettlement from './TransactionSettlement';
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
  Application: Application,
  Collective: Collective,
  Comment: Comment,
  EmojiReaction: EmojiReaction,
  ConnectedAccount: ConnectedAccount,
  Conversation: Conversation,
  ConversationFollower: ConversationFollower,
  CurrencyExchangeRate: CurrencyExchangeRate,
  Expense: Expense,
  ExpenseAttachedFile: ExpenseAttachedFile,
  ExpenseItem: ExpenseItem,
  HostApplication: HostApplication,
  LegalDocument: LegalDocument,
  Location: Location,
  Member: Member,
  MemberInvitation: MemberInvitation,
  MigrationLog: MigrationLog,
  Notification: Notification,
  OAuthAuthorizationCode: OAuthAuthorizationCode,
  Order: Order,
  PaymentMethod: PaymentMethod,
  PayoutMethod: PayoutMethod,
  PaypalPlan: PaypalPlan,
  PaypalProduct: PaypalProduct,
  RecurringExpense: RecurringExpense,
  RequiredLegalDocument: RequiredLegalDocument,
  Subscription: Subscription,
  SuspendedAsset: SuspendedAsset,
  Tier: Tier,
  Transaction: Transaction,
  TransactionSettlement: TransactionSettlement,
  Update: Update,
  UploadedFile: UploadedFile,
  User: User,
  UserToken: UserToken,
  VirtualCard: VirtualCard,
  VirtualCardRequest: VirtualCardRequest,
  PersonalToken: PersonalToken,
  SocialLink,
} as const;

/**
 * Relationships
 */

// AccountingCategory
models.AccountingCategory.belongsTo(models.Collective, { foreignKey: 'CollectiveId', as: 'collective' });
models.AccountingCategory.hasMany(models.Expense, { foreignKey: 'AccountingCategoryId', as: 'expenses' });

// Applications
models.Application.belongsTo(models.Collective, { foreignKey: 'CollectiveId', as: 'collective' });
models.Application.belongsTo(models.User, { foreignKey: 'CreatedByUserId', as: 'createdByUser' });
models.Application.hasMany(models.UserToken, { foreignKey: 'ApplicationId', as: 'userTokens' });

// Collective
models.Collective.belongsTo(models.Collective, { foreignKey: 'HostCollectiveId', as: 'host' });
models.Collective.belongsTo(models.Collective, { foreignKey: 'ParentCollectiveId', as: 'parent' });
models.Collective.belongsTo(models.Collective, { as: 'HostCollective' });
models.Collective.belongsToMany(models.Collective, {
  as: 'memberCollectives',
  through: {
    model: models.Member,
    unique: false,
    foreignKey: 'MemberCollectiveId',
  } as any,
});
models.Collective.belongsToMany(models.Collective, {
  through: { model: models.Member, unique: false, foreignKey: 'CollectiveId' } as any,
  as: 'memberOfCollectives',
});
models.Collective.hasMany(models.AccountingCategory, { foreignKey: 'CollectiveId', as: 'accountingCategories' });
models.Collective.hasMany(models.Member, { foreignKey: 'MemberCollectiveId', as: 'memberships' });
models.Collective.hasMany(models.Member); // TODO: This one probably has the same effect as the one below, we should check and remove if that's the case
models.Collective.hasMany(models.Member, { foreignKey: 'CollectiveId', as: 'members' });
models.Collective.hasMany(models.Activity);
models.Collective.hasMany(models.Notification);
models.Collective.hasMany(models.Tier, { as: 'tiers' });
models.Collective.hasMany(models.LegalDocument);
models.Collective.hasMany(models.RequiredLegalDocument, { foreignKey: 'HostCollectiveId' });
models.Collective.hasMany(models.Collective, { as: 'hostedCollectives', foreignKey: 'HostCollectiveId' });
models.Collective.hasMany(models.Expense, { foreignKey: 'CollectiveId', as: 'submittedExpenses' });
models.Collective.hasMany(models.ConnectedAccount);

// Connected accounts
models.ConnectedAccount.belongsTo(models.Collective, { foreignKey: 'CollectiveId', as: 'collective' });

// Conversations
models.Conversation.belongsTo(models.Collective, { foreignKey: 'CollectiveId', as: 'collective' });
models.Conversation.belongsTo(models.Collective, { foreignKey: 'FromCollectiveId', as: 'fromCollective' });

// Conversations followers
models.ConversationFollower.belongsTo(models.User, { foreignKey: 'UserId', as: 'user' });
models.ConversationFollower.belongsTo(models.Conversation, { foreignKey: 'ConversationId', as: 'conversation' });

// PaymentMethod
models.PaymentMethod.belongsTo(models.Collective);
models.PaymentMethod.belongsTo(models.PaymentMethod, {
  as: 'sourcePaymentMethod',
  foreignKey: 'SourcePaymentMethodId',
});

// User
models.User.hasMany(models.Activity);
models.User.hasMany(models.Notification);
models.User.hasMany(models.Transaction, {
  foreignKey: 'CreatedByUserId',
  as: 'transactions',
});
models.User.hasMany(models.Order, { foreignKey: 'CreatedByUserId', as: 'orders' });
models.User.hasMany(models.PaymentMethod, { foreignKey: 'CreatedByUserId' });
models.User.hasMany(models.Member, { foreignKey: 'CreatedByUserId' });
models.User.hasMany(models.ConnectedAccount, { foreignKey: 'CreatedByUserId' });
models.User.hasMany(models.UserToken, { foreignKey: 'UserId' });
models.User.belongsTo(models.Collective, {
  as: 'collective',
  foreignKey: 'CollectiveId',
  constraints: false,
});

// User tokens
models.UserToken.belongsTo(models.User, { foreignKey: 'UserId', as: 'user' });
models.UserToken.belongsTo(models.Application, { foreignKey: 'ApplicationId', as: 'client' });

// Personal tokens
models.PersonalToken.belongsTo(models.User, { foreignKey: 'UserId', as: 'user' });
models.PersonalToken.belongsTo(models.Collective, { foreignKey: 'CollectiveId', as: 'collective' });

// Members
models.Member.belongsTo(models.User, {
  foreignKey: 'CreatedByUserId',
  as: 'createdByUser',
});
models.Member.belongsTo(models.Collective, {
  foreignKey: 'MemberCollectiveId',
  as: 'memberCollective',
});
models.Member.belongsTo(models.Collective, {
  foreignKey: 'CollectiveId',
  as: 'collective',
});
models.Member.belongsTo(models.Tier);

// Member invitations
models.MemberInvitation.belongsTo(models.User, {
  foreignKey: 'CreatedByUserId',
  as: 'createdByUser',
});

models.MemberInvitation.belongsTo(models.Collective, {
  foreignKey: 'MemberCollectiveId',
  as: 'memberCollective',
});

models.MemberInvitation.belongsTo(models.Collective, {
  foreignKey: 'CollectiveId',
  as: 'collective',
});

models.MemberInvitation.belongsTo(models.Tier);

// Activity.
models.Activity.belongsTo(models.Collective);
models.Activity.belongsTo(models.User);
models.Activity.belongsTo(models.Transaction);
models.Activity.belongsTo(models.Expense);

// Notification.
models.Notification.belongsTo(models.User);

models.Notification.belongsTo(models.Collective);

// OAuthAuthorizationCode
models.OAuthAuthorizationCode.belongsTo(models.Application, { foreignKey: 'ApplicationId', as: 'application' });
models.OAuthAuthorizationCode.belongsTo(models.User, { foreignKey: 'UserId', as: 'user' });

// Transactions
models.Collective.hasMany(models.Transaction, { foreignKey: 'CollectiveId' });
models.Transaction.belongsTo(models.Collective, {
  foreignKey: 'CollectiveId',
  as: 'collective',
});
models.Transaction.belongsTo(models.Collective, {
  foreignKey: 'FromCollectiveId',
  as: 'fromCollective',
});
models.Transaction.belongsTo(models.Collective, {
  foreignKey: 'UsingGiftCardFromCollectiveId',
  as: 'usingGiftCardFromCollective',
});

models.Transaction.belongsTo(models.User, {
  foreignKey: 'CreatedByUserId',
  as: 'createdByUser',
});
models.Transaction.belongsTo(models.Collective, {
  foreignKey: 'HostCollectiveId',
  as: 'host',
});
models.Transaction.belongsTo(models.PaymentMethod);
models.Transaction.belongsTo(models.PayoutMethod);

models.PaymentMethod.hasMany(models.Transaction);

// Transaction settlements
models.TransactionSettlement.belongsTo(models.Expense);

// Expense
models.Expense.belongsTo(models.AccountingCategory, {
  as: 'accountingCategory',
  foreignKey: 'AccountingCategoryId',
});
models.Expense.belongsTo(models.User);
models.Expense.belongsTo(models.PayoutMethod);
models.Expense.belongsTo(models.Collective, {
  foreignKey: 'CollectiveId',
  as: 'collective',
});
models.Expense.belongsTo(models.Collective, {
  foreignKey: 'FromCollectiveId',
  as: 'fromCollective',
});
models.Expense.belongsTo(models.Collective, {
  foreignKey: 'HostCollectiveId',
  as: 'host',
});
models.Expense.belongsTo(models.VirtualCard, {
  foreignKey: 'VirtualCardId',
  as: 'virtualCard',
});
models.Expense.belongsTo(models.RecurringExpense, {
  foreignKey: 'RecurringExpenseId',
  as: 'recurringExpense',
});
models.Expense.hasMany(models.ExpenseAttachedFile, { as: 'attachedFiles' });
models.Expense.hasMany(models.ExpenseItem, { as: 'items' });
models.Expense.hasMany(models.Comment, { as: 'comments' });
models.Expense.hasMany(models.Transaction);
models.Expense.hasMany(models.Activity, { as: 'activities' });
models.Transaction.belongsTo(models.Expense);
models.Transaction.belongsTo(models.Order);

// Expense items
models.ExpenseItem.belongsTo(models.Expense);

// Expense attached files
models.ExpenseAttachedFile.belongsTo(models.Expense);

// Recurring Expenses
models.RecurringExpense.hasMany(models.Expense, { as: 'expenses' });
models.RecurringExpense.belongsTo(models.Collective, {
  foreignKey: 'CollectiveId',
  as: 'collective',
});
models.RecurringExpense.belongsTo(models.Collective, {
  foreignKey: 'FromCollectiveId',
  as: 'fromCollective',
});

// Comment
models.Comment.belongsTo(models.Collective, { foreignKey: 'CollectiveId', as: 'collective' });
models.Comment.belongsTo(models.Collective, { foreignKey: 'FromCollectiveId', as: 'fromCollective' });
models.Comment.belongsTo(models.Expense, { foreignKey: 'ExpenseId', as: 'expense' });
models.Comment.belongsTo(models.Update, { foreignKey: 'UpdateId', as: 'update' });
models.Comment.belongsTo(models.User, { foreignKey: 'CreatedByUserId', as: 'user' });

// Comment reactions
models.EmojiReaction.belongsTo(models.Comment);
models.EmojiReaction.belongsTo(models.User);

// Order.
models.Order.belongsTo(models.User, {
  foreignKey: 'CreatedByUserId',
  as: 'createdByUser',
});
models.Order.belongsTo(models.Collective, {
  foreignKey: 'FromCollectiveId',
  as: 'fromCollective',
});
models.Order.belongsTo(models.Collective, {
  foreignKey: 'CollectiveId',
  as: 'collective',
});
models.Order.belongsTo(models.Tier);
// m.Collective.hasMany(m.Order); // makes the test `mocha test/graphql.transaction.test.js -g "insensitive" fail
models.Collective.hasMany(models.Collective, { foreignKey: 'ParentCollectiveId', as: 'children' });
models.Collective.hasMany(models.Order, { foreignKey: 'CollectiveId', as: 'orders' });
models.Collective.hasMany(models.LegalDocument, { foreignKey: 'CollectiveId', as: 'legalDocuments' });
models.Collective.hasOne(models.User, {
  as: 'user',
  foreignKey: 'CollectiveId',
  constraints: false,
});
models.Transaction.belongsTo(models.Order);
models.Order.hasMany(models.Transaction);
models.Tier.hasMany(models.Order);

// Legal documents
models.LegalDocument.belongsTo(models.Collective, { foreignKey: 'CollectiveId', as: 'collective' });

// Location
models.Location.belongsTo(models.Collective, { foreignKey: 'CollectiveId', as: 'collective' });
models.Collective.hasOne(models.Location, { foreignKey: 'CollectiveId', as: 'location' });

// RequiredLegalDocument
models.RequiredLegalDocument.belongsTo(models.Collective, { foreignKey: 'HostCollectiveId', as: 'hostCollective' });

// Subscription
models.Order.belongsTo(models.Subscription); // adds SubscriptionId to the Orders table
models.Subscription.hasOne(models.Order);

// PaymentMethod
models.Order.belongsTo(models.PaymentMethod, {
  foreignKey: 'PaymentMethodId',
  as: 'paymentMethod',
});
models.PaymentMethod.hasMany(models.Order);
models.Transaction.belongsTo(models.PaymentMethod);

// Payout method
models.PayoutMethod.belongsTo(models.User, { foreignKey: 'CreatedByUserId', as: 'createdByUser' });
models.PayoutMethod.belongsTo(models.Collective);
models.Collective.hasMany(models.PayoutMethod);

// Paypal
models.PaypalPlan.belongsTo(models.PaypalProduct, {
  foreignKey: 'ProductId',
  as: 'product',
});

models.PaypalProduct.hasMany(models.PaypalPlan, {
  foreignKey: 'ProductId',
  as: 'plans',
});

// Tier
models.Tier.belongsTo(models.Collective);

// Update
models.Update.belongsTo(models.Collective, { foreignKey: 'CollectiveId', as: 'collective' });
models.Update.belongsTo(models.Collective, { foreignKey: 'FromCollectiveId', as: 'fromCollective' });
models.Update.belongsTo(models.Tier, { foreignKey: 'TierId', as: 'tier' });
models.Update.belongsTo(models.User, { foreignKey: 'LastEditedByUserId', as: 'user' });

// Uploaded files
models.UploadedFile.belongsTo(models.User, { foreignKey: 'CreatedByUserId', as: 'user' });

// VirtualCard
models.VirtualCard.belongsTo(models.Collective, {
  foreignKey: 'CollectiveId',
  as: 'collective',
});
models.VirtualCard.belongsTo(models.Collective, {
  foreignKey: 'HostCollectiveId',
  as: 'host',
});
models.VirtualCard.belongsTo(models.User, {
  foreignKey: 'UserId',
  as: 'user',
});

models.VirtualCard.belongsTo(models.VirtualCardRequest, {
  foreignKey: 'VirtualCardRequestId',
  as: 'virtualCardRequest',
});
models.VirtualCard.hasMany(models.Expense, { foreignKey: 'VirtualCardId', as: 'expenses' });
models.Collective.hasMany(models.VirtualCard, { foreignKey: 'HostCollectiveId', as: 'virtualCards' });
models.Collective.hasMany(models.VirtualCard, { foreignKey: 'CollectiveId', as: 'virtualCardCollectives' });

// VirtualCardRequest
models.VirtualCardRequest.belongsTo(models.Collective, {
  foreignKey: 'CollectiveId',
  as: 'collective',
});
models.VirtualCardRequest.belongsTo(models.Collective, {
  foreignKey: 'HostCollectiveId',
  as: 'host',
});
models.VirtualCardRequest.belongsTo(models.User, {
  foreignKey: 'UserId',
  as: 'user',
});
models.VirtualCardRequest.belongsTo(models.VirtualCard, {
  foreignKey: 'VirtualCardId',
  as: 'virtualCard',
});

// SocialLink
models.SocialLink.belongsTo(models.Collective, {
  foreignKey: 'CollectiveId',
  as: 'collective',
});
models.Collective.hasMany(models.SocialLink, { foreignKey: 'CollectiveId', as: 'socialLinks' });

UserTwoFactorMethod.belongsTo(User);
User.hasMany(UserTwoFactorMethod);

Agreement.belongsTo(Collective, { foreignKey: 'HostCollectiveId', as: 'Host' });
Agreement.belongsTo(Collective, { foreignKey: 'CollectiveId', as: 'Collective' });
Agreement.belongsTo(User, { foreignKey: 'UserId', as: 'User' });

// HostApplication
models.HostApplication.belongsTo(models.Collective, {
  foreignKey: 'CollectiveId',
  as: 'collective',
});
Collective.hasMany(models.HostApplication, {
  foreignKey: 'CollectiveId',
  as: 'hostApplications',
});

export default models;

export { sequelize, Op };

export {
  Activity,
  Application,
  Collective,
  Comment,
  EmojiReaction,
  ConnectedAccount,
  Conversation,
  ConversationFollower,
  CurrencyExchangeRate,
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
  RecurringExpense,
  RequiredLegalDocument,
  Subscription,
  SuspendedAsset,
  Tier,
  Transaction,
  TransactionSettlement,
  Update,
  UploadedFile,
  User,
  UserToken,
  VirtualCard,
  PersonalToken,
  SocialLink,
};

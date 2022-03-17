import sequelize, { Op } from '../lib/sequelize';

import Activity from './Activity';
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
import Member from './Member';
import MemberInvitation from './MemberInvitation';
import MigrationLog from './MigrationLog';
import Notification from './Notification';
import Order from './Order';
import PaymentMethod from './PaymentMethod';
import PayoutMethod from './PayoutMethod';
import PaypalPlan from './PaypalPlan';
import PaypalProduct from './PaypalProduct';
import RecurringExpense from './RecurringExpense';
import RequiredLegalDocument from './RequiredLegalDocument';
import Session from './Session';
import Subscription from './Subscription';
import Tier from './Tier';
import Transaction from './Transaction';
import TransactionSettlement from './TransactionSettlement';
import Update from './Update';
import User from './User';
import VirtualCard from './VirtualCard';

/**
 * Separate function to be able to use in scripts
 */
export function setupModels() {
  const m = {}; // models

  /**
   * Models.
   */
  m['Activity'] = Activity;
  m['Application'] = Application;
  m['Collective'] = Collective;
  m['Comment'] = Comment;
  m['EmojiReaction'] = EmojiReaction;
  m['ConnectedAccount'] = ConnectedAccount;
  m['Conversation'] = Conversation;
  m['ConversationFollower'] = ConversationFollower;
  m['CurrencyExchangeRate'] = CurrencyExchangeRate;
  m['Expense'] = Expense;
  m['ExpenseAttachedFile'] = ExpenseAttachedFile;
  m['ExpenseItem'] = ExpenseItem;
  m['HostApplication'] = HostApplication;
  m['LegalDocument'] = LegalDocument;
  m['Member'] = Member;
  m['MemberInvitation'] = MemberInvitation;
  m['MigrationLog'] = MigrationLog;
  m['Notification'] = Notification;
  m['Order'] = Order;
  m['PaymentMethod'] = PaymentMethod;
  m['PayoutMethod'] = PayoutMethod;
  m['PaypalPlan'] = PaypalPlan;
  m['PaypalProduct'] = PaypalProduct;
  m['RecurringExpense'] = RecurringExpense;
  m['RequiredLegalDocument'] = RequiredLegalDocument;
  m['Session'] = Session;
  m['Subscription'] = Subscription;
  m['Tier'] = Tier;
  m['Transaction'] = Transaction;
  m['TransactionSettlement'] = TransactionSettlement;
  m['Update'] = Update;
  m['User'] = User;
  m['VirtualCard'] = VirtualCard;

  /**
   * Relationships
   */

  // Collective
  m.Collective.belongsTo(m.Collective, { foreignKey: 'HostCollectiveId', as: 'host' });
  m.Collective.belongsTo(m.Collective, { as: 'HostCollective' });
  m.Collective.belongsToMany(m.Collective, {
    as: 'memberCollectives',
    through: {
      model: m.Member,
      unique: false,
      foreignKey: 'MemberCollectiveId',
    },
  });
  m.Collective.belongsToMany(m.Collective, {
    through: { model: m.Member, unique: false, foreignKey: 'CollectiveId' },
    as: 'memberOfCollectives',
  });
  m.Collective.hasMany(m.Member, { foreignKey: 'MemberCollectiveId', as: 'memberships' });
  m.Collective.hasMany(m.Member); // TODO: This one probably has the same effect as the one below, we should check and remove if that's the case
  m.Collective.hasMany(m.Member, { foreignKey: 'CollectiveId', as: 'members' });
  m.Collective.hasMany(m.Activity);
  m.Collective.hasMany(m.Notification);
  m.Collective.hasMany(m.Tier, { as: 'tiers' });
  m.Collective.hasMany(m.LegalDocument);
  m.Collective.hasMany(m.RequiredLegalDocument, { foreignKey: 'HostCollectiveId' });
  m.Collective.hasMany(m.Collective, { as: 'hostedCollectives', foreignKey: 'HostCollectiveId' });
  m.Collective.hasMany(m.Expense, { foreignKey: 'CollectiveId', as: 'submittedExpenses' });
  m.Collective.hasMany(m.ConnectedAccount);

  // Connected accounts
  m.ConnectedAccount.belongsTo(m.Collective, { foreignKey: 'CollectiveId', as: 'collective' });

  // Conversations
  m.Conversation.belongsTo(m.Collective, { foreignKey: 'CollectiveId', as: 'collective' });
  m.Conversation.belongsTo(m.Collective, { foreignKey: 'FromCollectiveId', as: 'fromCollective' });

  // Conversations followers
  m.ConversationFollower.belongsTo(m.User, { foreignKey: 'UserId', as: 'user' });
  m.ConversationFollower.belongsTo(m.Conversation, { foreignKey: 'ConversationId', as: 'conversation' });

  // PaymentMethod
  m.PaymentMethod.belongsTo(m.Collective);
  m.PaymentMethod.belongsTo(m.PaymentMethod, {
    as: 'sourcePaymentMethod',
    foreignKey: 'SourcePaymentMethodId',
  });

  // User
  m.User.hasMany(m.Activity);
  m.User.hasMany(m.Notification);
  m.User.hasMany(m.Transaction, {
    foreignKey: 'CreatedByUserId',
    as: 'transactions',
  });
  m.User.hasMany(m.Order, { foreignKey: 'CreatedByUserId', as: 'orders' });
  m.User.hasMany(m.PaymentMethod, { foreignKey: 'CreatedByUserId' });
  m.User.hasMany(m.Member, { foreignKey: 'CreatedByUserId' });
  m.User.hasMany(m.ConnectedAccount, { foreignKey: 'CreatedByUserId' });
  m.User.belongsTo(m.Collective, {
    as: 'collective',
    foreignKey: 'CollectiveId',
    constraints: false,
  });

  // Members
  m.Member.belongsTo(m.User, {
    foreignKey: 'CreatedByUserId',
    as: 'createdByUser',
  });
  m.Member.belongsTo(m.Collective, {
    foreignKey: 'MemberCollectiveId',
    as: 'memberCollective',
  });
  m.Member.belongsTo(m.Collective, {
    foreignKey: 'CollectiveId',
    as: 'collective',
  });
  m.Member.belongsTo(m.Tier);

  // Member invitations
  m.MemberInvitation.belongsTo(m.User, {
    foreignKey: 'CreatedByUserId',
    as: 'createdByUser',
  });

  m.MemberInvitation.belongsTo(m.Collective, {
    foreignKey: 'MemberCollectiveId',
    as: 'memberCollective',
  });

  m.MemberInvitation.belongsTo(m.Collective, {
    foreignKey: 'CollectiveId',
    as: 'collective',
  });

  m.MemberInvitation.belongsTo(m.Tier);

  // Activity.
  m.Activity.belongsTo(m.Collective);
  m.Activity.belongsTo(m.User);
  m.Activity.belongsTo(m.Transaction);

  // Notification.
  m.Notification.belongsTo(m.User);

  m.Notification.belongsTo(m.Collective);

  // Transactions
  m.Collective.hasMany(m.Transaction, { foreignKey: 'CollectiveId' });
  m.Transaction.belongsTo(m.Collective, {
    foreignKey: 'CollectiveId',
    as: 'collective',
  });
  m.Transaction.belongsTo(m.Collective, {
    foreignKey: 'FromCollectiveId',
    as: 'fromCollective',
  });
  m.Transaction.belongsTo(m.Collective, {
    foreignKey: 'UsingGiftCardFromCollectiveId',
    as: 'usingGiftCardFromCollective',
  });

  m.Transaction.belongsTo(m.User, {
    foreignKey: 'CreatedByUserId',
    as: 'createdByUser',
  });
  m.Transaction.belongsTo(m.Collective, {
    foreignKey: 'HostCollectiveId',
    as: 'host',
  });
  m.Transaction.belongsTo(m.PaymentMethod);
  m.PaymentMethod.hasMany(m.Transaction);

  // Transaction settlements
  m.TransactionSettlement.belongsTo(m.Expense);

  // Expense
  m.Expense.belongsTo(m.User);
  m.Expense.belongsTo(m.PayoutMethod);
  m.Expense.belongsTo(m.Collective, {
    foreignKey: 'CollectiveId',
    as: 'collective',
  });
  m.Expense.belongsTo(m.Collective, {
    foreignKey: 'FromCollectiveId',
    as: 'fromCollective',
  });
  m.Expense.belongsTo(m.Collective, {
    foreignKey: 'HostCollectiveId',
    as: 'host',
  });
  m.Expense.belongsTo(m.VirtualCard, {
    foreignKey: 'VirtualCardId',
    as: 'virtualCard',
  });
  m.Expense.belongsTo(m.RecurringExpense, {
    foreignKey: 'RecurringExpenseId',
    as: 'recurringExpense',
  });
  m.Expense.hasMany(m.ExpenseAttachedFile, { as: 'attachedFiles' });
  m.Expense.hasMany(m.ExpenseItem, { as: 'items' });
  m.Expense.hasMany(m.Transaction);
  m.Transaction.belongsTo(m.Expense);
  m.Transaction.belongsTo(m.Order);

  // Expense items
  m.ExpenseItem.belongsTo(m.Expense);

  // Expense attached files
  m.ExpenseAttachedFile.belongsTo(m.Expense);

  // Recurring Expenses
  m.RecurringExpense.hasMany(m.Expense, { as: 'expenses' });
  m.RecurringExpense.belongsTo(m.Collective, {
    foreignKey: 'CollectiveId',
    as: 'collective',
  });
  m.RecurringExpense.belongsTo(m.Collective, {
    foreignKey: 'FromCollectiveId',
    as: 'fromCollective',
  });

  // Comment
  m.Comment.belongsTo(m.Collective, { foreignKey: 'CollectiveId', as: 'collective' });
  m.Comment.belongsTo(m.Collective, { foreignKey: 'FromCollectiveId', as: 'fromCollective' });
  m.Comment.belongsTo(m.Expense, { foreignKey: 'ExpenseId', as: 'expense' });
  m.Comment.belongsTo(m.Update, { foreignKey: 'UpdateId', as: 'update' });
  m.Comment.belongsTo(m.User, { foreignKey: 'CreatedByUserId', as: 'user' });

  // Comment reactions
  m.EmojiReaction.belongsTo(m.Comment);
  m.EmojiReaction.belongsTo(m.User);

  // Order.
  m.Order.belongsTo(m.User, {
    foreignKey: 'CreatedByUserId',
    as: 'createdByUser',
  });
  m.Order.belongsTo(m.Collective, {
    foreignKey: 'FromCollectiveId',
    as: 'fromCollective',
  });
  m.Order.belongsTo(m.Collective, {
    foreignKey: 'CollectiveId',
    as: 'collective',
  });
  m.Order.belongsTo(m.Tier);
  // m.Collective.hasMany(m.Order); // makes the test `mocha test/graphql.transaction.test.js -g "insensitive" fail
  m.Collective.hasMany(m.Collective, { foreignKey: 'ParentCollectiveId', as: 'children' });
  m.Collective.hasMany(m.Order, { foreignKey: 'CollectiveId', as: 'orders' });
  m.Collective.hasMany(m.LegalDocument, { foreignKey: 'CollectiveId', as: 'legalDocuments' });
  m.Collective.hasOne(m.User, {
    as: 'user',
    foreignKey: 'CollectiveId',
    constraints: false,
    allowNull: true,
    defaultValue: null,
  });
  m.Transaction.belongsTo(m.Order);
  m.Order.hasMany(m.Transaction);
  m.Tier.hasMany(m.Order);

  // Legal documents
  m.LegalDocument.belongsTo(m.Collective, { foreignKey: 'CollectiveId', as: 'collective' });

  // RequiredLegalDocument
  m.RequiredLegalDocument.belongsTo(m.Collective, { foreignKey: 'HostCollectiveId', as: 'hostCollective' });

  // Subscription
  m.Order.belongsTo(m.Subscription); // adds SubscriptionId to the Orders table
  m.Subscription.hasOne(m.Order);

  // PaymentMethod
  m.Order.belongsTo(m.PaymentMethod, {
    foreignKey: 'PaymentMethodId',
    as: 'paymentMethod',
  });
  m.PaymentMethod.hasMany(m.Order);
  m.Transaction.belongsTo(m.PaymentMethod);

  // Payout method
  m.PayoutMethod.belongsTo(m.User, { foreignKey: 'CreatedByUserId', as: 'createdByUser' });
  m.PayoutMethod.belongsTo(m.Collective);
  m.Collective.hasMany(m.PayoutMethod);

  // Paypal
  m.PaypalPlan.belongsTo(m.PaypalProduct, {
    foreignKey: 'ProductId',
    as: 'product',
  });

  m.PaypalProduct.hasMany(m.PaypalPlan, {
    foreignKey: 'ProductId',
    as: 'plans',
  });

  // Tier
  m.Tier.belongsTo(m.Collective);

  // Update
  m.Update.belongsTo(m.Collective, { foreignKey: 'CollectiveId', as: 'collective' });
  m.Update.belongsTo(m.Collective, { foreignKey: 'FromCollectiveId', as: 'fromCollective' });
  m.Update.belongsTo(m.Tier, { foreignKey: 'TierId', as: 'tier' });
  m.Update.belongsTo(m.User, { foreignKey: 'LastEditedByUserId', as: 'user' });

  // VirtualCard
  m.VirtualCard.belongsTo(m.Collective, {
    foreignKey: 'CollectiveId',
    as: 'collective',
  });
  m.VirtualCard.belongsTo(m.Collective, {
    foreignKey: 'HostCollectiveId',
    as: 'host',
  });
  m.VirtualCard.belongsTo(m.User, {
    foreignKey: 'UserId',
    as: 'user',
  });
  m.VirtualCard.hasMany(m.Expense, { foreignKey: 'VirtualCardId', as: 'expenses' });
  m.Collective.hasMany(m.VirtualCard, { foreignKey: 'HostCollectiveId', as: 'virtualCards' });
  m.Collective.hasMany(m.VirtualCard, { foreignKey: 'CollectiveId', as: 'virtualCardCollectives' });

  return m;
}

const models = setupModels();

export { sequelize, Op };

export default models;

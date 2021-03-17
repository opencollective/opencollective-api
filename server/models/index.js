import sequelize, { Op } from '../lib/sequelize';

import Activity from './Activity';
import Application from './Application';
import Collective from './Collective';
import Comment from './Comment';
import CommentReaction from './CommentReaction';
import ConnectedAccount from './ConnectedAccount';
import Conversation from './Conversation';
import ConversationFollower from './ConversationFollower';
import CurrencyExchangeRate from './CurrencyExchangeRate';
import Expense from './Expense';
import ExpenseAttachedFile from './ExpenseAttachedFile';
import ExpenseItem from './ExpenseItem';
import HostApplication from './HostApplication';
import LegalDocument from './LegalDocument';
import Member from './Member';
import MemberInvitation from './MemberInvitation';
import Notification from './Notification';
import Order from './Order';
import PaymentMethod from './PaymentMethod';
import PayoutMethod from './PayoutMethod';
import RequiredLegalDocument from './RequiredLegalDocument';
import Session from './Session';
import Subscription from './Subscription';
import Tier from './Tier';
import Transaction from './Transaction';
import Update from './Update';
import User from './User';

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
  m['ConnectedAccount'] = ConnectedAccount;
  m['Collective'] = Collective;
  m['Comment'] = Comment;
  m['CommentReaction'] = CommentReaction;
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
  m['Notification'] = Notification;
  m['Order'] = Order;
  m['PaymentMethod'] = PaymentMethod;
  m['PayoutMethod'] = PayoutMethod;
  m['RequiredLegalDocument'] = RequiredLegalDocument;
  m['Session'] = Session;
  m['Subscription'] = Subscription;
  m['Tier'] = Tier;
  m['Transaction'] = Transaction;
  m['Update'] = Update;
  m['User'] = User;

  /**
   * Relationships
   */

  // PaymentMethod.
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

  // Transaction.
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
  m.Expense.hasMany(m.ExpenseAttachedFile, { as: 'attachedFiles' });
  m.Expense.hasMany(m.ExpenseItem, { as: 'items' });
  m.Expense.hasMany(m.Transaction);
  m.Transaction.belongsTo(m.Expense);
  m.Transaction.belongsTo(m.Order);

  // Expense items
  m.ExpenseItem.belongsTo(m.Expense);

  // Expense attached files
  m.ExpenseAttachedFile.belongsTo(m.Expense);

  // Comment reactions
  m.CommentReaction.belongsTo(m.Comment);
  m.CommentReaction.belongsTo(m.User);

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
  m.Collective.hasMany(m.Member, { foreignKey: 'CollectiveId', as: 'members' });
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
  m.LegalDocument.belongsTo(m.Collective);

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

  // Tier
  m.Tier.belongsTo(m.Collective);

  Object.keys(m).forEach(modelName => m[modelName].associate && m[modelName].associate(m));

  return m;
}

const models = setupModels();

export { sequelize, Op };

export default models;

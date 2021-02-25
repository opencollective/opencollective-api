import Sequelize from 'sequelize';

import sequelize from '../lib/sequelize';

/**
 * Separate function to be able to use in scripts
 */
export function setupModels() {
  const m = {}; // models

  /**
   * Models.
   */
  m['Activity'] = require('./Activity');
  m['Application'] = require('./Application');
  m['ConnectedAccount'] = require('./ConnectedAccount');
  m['Collective'] = require('./Collective');
  m['Comment'] = require('./Comment');
  m['CommentReaction'] = require('./CommentReaction');
  m['Conversation'] = require('./Conversation');
  m['ConversationFollower'] = require('./ConversationFollower');
  m['CurrencyExchangeRate'] = require('./CurrencyExchangeRate.ts');
  m['Expense'] = require('./Expense');
  m['ExpenseAttachedFile'] = require('./ExpenseAttachedFile.ts');
  m['ExpenseItem'] = require('./ExpenseItem.ts');
  m['HostApplication'] = require('./HostApplication.ts');
  m['LegalDocument'] = require('./LegalDocument');
  m['Member'] = require('./Member');
  m['MemberInvitation'] = require('./MemberInvitation');
  m['Notification'] = require('./Notification');
  m['Order'] = require('./Order');
  m['PaymentMethod'] = require('./PaymentMethod');
  m['PayoutMethod'] = require('./PayoutMethod.ts');
  m['RequiredLegalDocument'] = require('./RequiredLegalDocument');
  m['Session'] = require('./Session');
  m['Subscription'] = require('./Subscription');
  m['Tier'] = require('./Tier');
  m['Transaction'] = require('./Transaction');
  m['Update'] = require('./Update');
  m['User'] = require('./User');

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

const Op = Sequelize.Op;
const models = setupModels();

export { sequelize, Op };
export default models;

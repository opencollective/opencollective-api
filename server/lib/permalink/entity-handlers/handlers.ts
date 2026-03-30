import { CollectiveType } from '../../../constants/collectives';
import models from '../../../models';

import { handleAccessDenied, handleNotFound, handleUnauthorized } from './common';
import { getCollectivePageRoute, getDashboardRoute, type Handler, redirect } from './utils';

export const handleCollective: Handler = async (req, res) => {
  const collective = await models.Collective.findOne({
    where: { publicId: req.params.id },
    include: [{ model: models.Collective, as: 'host' }],
  });
  if (!collective) {
    return handleNotFound(req, res);
  }

  const isVendor = collective.type === CollectiveType.VENDOR;

  if (!req.remoteUser) {
    return isVendor ? handleUnauthorized(req, res) : redirect(res, await getCollectivePageRoute(collective));
  }

  if (isVendor && !req.remoteUser.isAdmin(collective.ParentCollectiveId)) {
    return handleAccessDenied(req, res);
  }

  if (isVendor) {
    const parent = await models.Collective.findByPk(collective.ParentCollectiveId);
    if (!parent) {
      return handleNotFound(req, res);
    }
    return redirect(res, getDashboardRoute(parent, `vendors/${collective.publicId}`));
  }

  if (req.remoteUser.isAdmin(collective.id)) {
    return redirect(res, getDashboardRoute(collective, 'overview'));
  }

  const isHostedAccount = collective.host && collective.approvedAt;

  if (isHostedAccount && req.remoteUser.isAdmin(collective.HostCollectiveId)) {
    return redirect(res, getDashboardRoute(collective.host, `hosted-collectives/${collective.publicId}`));
  }

  return redirect(res, await getCollectivePageRoute(collective));
};

export const handleUser: Handler = async (req, res) => {
  const user = await models.User.findOne({
    where: { publicId: req.params.id },
    include: [{ model: models.Collective, as: 'collective', required: true }],
  });
  if (!user) {
    return handleNotFound(req, res);
  }

  if (!req.remoteUser) {
    return redirect(res, await getCollectivePageRoute(user.collective));
  }

  if (req.remoteUser.isAdmin(user.CollectiveId)) {
    return redirect(res, getDashboardRoute(user.collective, 'overview'));
  }

  return redirect(res, await getCollectivePageRoute(user.collective));
};

export const handleMember: Handler = async (req, res) => {
  const member = await models.Member.findOne({
    where: { publicId: req.params.id },
    include: [
      { model: models.Collective, as: 'collective', required: true },
      { model: models.Collective, as: 'memberCollective', required: true },
    ],
  });
  if (!member) {
    return handleNotFound(req, res);
  }

  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  if (req.remoteUser.isAdmin(member.collective.id)) {
    return redirect(res, getDashboardRoute(member.collective, `people/${member.memberCollective.publicId}`));
  }

  if (req.remoteUser.isAdmin(member.memberCollective.id)) {
    return redirect(res, await getCollectivePageRoute(member.collective));
  }

  return redirect(res, await getCollectivePageRoute(member.collective));
};

export const handleMemberInvitation: Handler = async (req, res) => {
  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  const invitation = await models.MemberInvitation.findOne({
    where: { publicId: req.params.id },
    include: [
      { model: models.Collective, as: 'collective', required: true },
      { model: models.Collective, as: 'memberCollective', required: true },
    ],
  });
  if (!invitation) {
    return handleNotFound(req, res);
  }

  if (req.remoteUser.isAdmin(invitation.collective.id)) {
    return redirect(res, getDashboardRoute(invitation.collective, 'team'));
  }

  if (req.remoteUser.isAdmin(invitation.memberCollective.id)) {
    return redirect(res, await getCollectivePageRoute(invitation.collective));
  }

  return handleAccessDenied(req, res);
};

export const handlePersonalToken: Handler = async (req, res) => {
  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  const token = await models.PersonalToken.findOne({
    where: { publicId: req.params.id },
    include: { model: models.Collective, as: 'collective', required: true },
  });
  if (!token) {
    return handleNotFound(req, res);
  }

  if (!req.remoteUser.isAdmin(token.collective.id)) {
    return handleAccessDenied(req, res);
  }

  return redirect(res, getDashboardRoute(token.collective, `for-developers/personal-tokens/${token.publicId}`));
};

export const handleUserToken: Handler = async (req, res) => {
  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  const token = await models.UserToken.findOne({ where: { publicId: req.params.id } });
  if (!token) {
    return handleNotFound(req, res);
  }

  if (req.remoteUser.id !== token.UserId) {
    return handleAccessDenied(req, res);
  }

  return redirect(res, getDashboardRoute(req.remoteUser.collective, 'overview'));
};

export const handleUserTwoFactorMethod: Handler = async (req, res) => {
  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  const twoFactorMethod = await models.UserTwoFactorMethod.findOne({ where: { publicId: req.params.id } });
  if (!twoFactorMethod) {
    return handleNotFound(req, res);
  }

  if (req.remoteUser.id !== twoFactorMethod.UserId) {
    return handleAccessDenied(req, res);
  }

  const user = await models.User.findByPk(twoFactorMethod.UserId, {
    include: { model: models.Collective, as: 'collective', required: true },
  });
  if (!user) {
    return handleNotFound(req, res);
  }

  return redirect(res, getDashboardRoute(user.collective, `user-security`));
};

export const handleUpdate: Handler = async (req, res) => {
  const update = await models.Update.findOne({
    where: { publicId: req.params.id },
    include: { model: models.Collective, as: 'collective', required: true },
  });
  if (!update) {
    return handleNotFound(req, res);
  }

  if (!req.remoteUser) {
    return redirect(res, `${await getCollectivePageRoute(update.collective)}/updates/${update.slug}`);
  }

  if (req.remoteUser.isAdmin(update.collective.id)) {
    return redirect(res, getDashboardRoute(update.collective, `updates/${update.publicId}`));
  }

  return redirect(res, `${await getCollectivePageRoute(update.collective)}/updates/${update.slug}`);
};

export const handleConversation: Handler = async (req, res) => {
  const conversation = await models.Conversation.findOne({
    where: { publicId: req.params.id },
    include: { model: models.Collective, as: 'collective', required: true },
  });
  if (!conversation) {
    return handleNotFound(req, res);
  }

  return redirect(
    res,
    `${await getCollectivePageRoute(conversation.collective)}/conversations/${conversation.slug}-${conversation.publicId}`,
  );
};

export const handleComment: Handler = async (req, res) => {
  const comment = await models.Comment.findOne({
    where: { publicId: req.params.id },
    include: [
      { model: models.Collective, as: 'collective', required: true },
      { model: models.Collective, as: 'fromCollective', required: true },
    ],
  });
  if (!comment) {
    return handleNotFound(req, res);
  }

  if (comment.ConversationId) {
    req.params.id = await models.Conversation.findByPk(comment.ConversationId).then(
      conversation => conversation.publicId,
    );
    return handleConversation(req, res);
  } else if (comment.UpdateId) {
    req.params.id = await models.Update.findByPk(comment.UpdateId).then(update => update.publicId);
    return handleUpdate(req, res);
  } else if (comment.ExpenseId) {
    req.params.id = await models.Expense.findByPk(comment.ExpenseId).then(expense => expense.publicId);
    return handleExpense(req, res);
  } else if (comment.HostApplicationId) {
    req.params.id = await models.HostApplication.findByPk(comment.HostApplicationId).then(
      hostApplication => hostApplication.publicId,
    );
    return handleHostApplication(req, res);
  } else if (comment.OrderId) {
    req.params.id = await models.Order.findByPk(comment.OrderId).then(order => order.publicId);
    return handleOrder(req, res);
  }

  return handleNotFound(req, res);
};

export const handleActivity: Handler = async (req, res) => {
  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  const activity = await models.Activity.findOne({ where: { publicId: req.params.id } });
  if (!activity) {
    return handleNotFound(req, res);
  }

  const collective = activity.CollectiveId && (await models.Collective.findByPk(activity.CollectiveId));
  const hostCollective = activity.HostCollectiveId && (await models.Collective.findByPk(activity.HostCollectiveId));

  if (collective && req.remoteUser.isAdmin(collective.id)) {
    return redirect(res, getDashboardRoute(collective, 'activity-log'));
  }

  if (hostCollective && req.remoteUser.isAdmin(hostCollective.id)) {
    return redirect(res, getDashboardRoute(hostCollective, 'activity-log'));
  }

  return handleAccessDenied(req, res);
};

export const handleTier: Handler = async (req, res) => {
  const tier = await models.Tier.findOne({
    where: { publicId: req.params.id },
    include: { model: models.Collective, as: 'Collective', required: true },
  });
  if (!tier) {
    return handleNotFound(req, res);
  }

  return redirect(res, `${await getCollectivePageRoute(tier.Collective)}/contribute/${tier.slug}-${tier.id}`);
};

export const handleApplication: Handler = async (req, res) => {
  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  const application = await models.Application.findOne({
    where: { publicId: req.params.id },
    include: { model: models.Collective, as: 'collective', required: true },
  });
  if (!application) {
    return handleNotFound(req, res);
  }

  if (!req.remoteUser.isAdmin(application.collective.id)) {
    return handleAccessDenied(req, res);
  }

  if (application.type === 'oAuth') {
    return redirect(res, getDashboardRoute(application.collective, `for-developers/oauth/${application.publicId}`));
  } else if (application.type === 'apiKey') {
    return redirect(
      res,
      getDashboardRoute(application.collective, `for-developers/personal-tokens/${application.publicId}`),
    );
  }

  return redirect(res, getDashboardRoute(application.collective, 'for-developers'));
};

export const handleHostApplication: Handler = async (req, res) => {
  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  const application = await models.HostApplication.findOne({
    where: { publicId: req.params.id },
    include: [
      { model: models.Collective, as: 'collective', required: true },
      { model: models.Collective, as: 'host', required: true },
    ],
  });
  if (!application) {
    return handleNotFound(req, res);
  }

  if (req.remoteUser.isAdmin(application.host.id)) {
    return redirect(
      res,
      getDashboardRoute(application.host, 'host-applications', { hostApplicationId: application.publicId }),
    );
  }

  if (req.remoteUser.isAdmin(application.collective.id)) {
    return redirect(res, getDashboardRoute(application.collective, `host?hostApplicationId=${application.publicId}`));
  }

  return handleAccessDenied(req, res);
};

export const handleExportRequest: Handler = async (req, res) => {
  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  const exportRequest = await models.ExportRequest.findOne({
    where: { publicId: req.params.id },
    include: { model: models.Collective, as: 'collective', required: true },
  });
  if (!exportRequest) {
    return handleNotFound(req, res);
  }

  if (!req.remoteUser.isAdmin(exportRequest.collective.id)) {
    return handleAccessDenied(req, res);
  }

  return redirect(res, getDashboardRoute(exportRequest.collective, `exports/${exportRequest.publicId}`));
};

export const handleExpense: Handler = async (req, res) => {
  const expense = await models.Expense.findOne({
    where: { publicId: req.params.id },
    include: [
      { model: models.Collective, as: 'collective', required: true },
      { model: models.Collective, as: 'fromCollective' },
      { model: models.Collective, as: 'host' },
    ],
  });
  if (!expense) {
    return handleNotFound(req, res);
  }

  if (!req.remoteUser) {
    return redirect(res, `${await getCollectivePageRoute(expense.collective)}/expenses/${expense.id}`);
  }

  const hostCollectiveId = expense.HostCollectiveId || expense.collective?.HostCollectiveId;

  const host = await models.Collective.findByPk(hostCollectiveId);
  if (host && req.remoteUser.isAdmin(host.id)) {
    return redirect(res, getDashboardRoute(host, `host-payment-requests/${expense.id}`));
  }

  if (req.remoteUser.isAdmin(expense.collective.id)) {
    return redirect(res, getDashboardRoute(expense.collective, 'payment-requests', { openExpenseId: expense.id }));
  }

  if (req.remoteUser.isAdmin(expense.fromCollective.id)) {
    return redirect(
      res,
      getDashboardRoute(expense.fromCollective, 'submitted-expenses', { openExpenseId: expense.id }),
    );
  }

  return redirect(res, `${await getCollectivePageRoute(expense.collective)}/expenses/${expense.id}`);
};

export const handleOrder: Handler = async (req, res) => {
  const order = await models.Order.findOne({
    where: { publicId: req.params.id },
    include: [
      { model: models.Collective, as: 'fromCollective', required: true },
      { model: models.Collective, as: 'collective', required: true },
    ],
  });
  if (!order) {
    return handleNotFound(req, res);
  }

  if (!req.remoteUser) {
    return redirect(res, `${await getCollectivePageRoute(order.collective)}/orders/${order.id}`);
  }

  if (req.remoteUser.isAdmin(order.fromCollective.id)) {
    return redirect(res, getDashboardRoute(order.fromCollective, 'outgoing-contributions', { orderId: order.id }));
  }

  if (req.remoteUser.isAdmin(order.collective.id)) {
    return redirect(res, getDashboardRoute(order.collective, 'incoming-contributions', { orderId: order.id }));
  }

  const hostCollectiveId = order.collective?.HostCollectiveId;
  const host = await models.Collective.findByPk(hostCollectiveId);

  if (host && req.remoteUser.isAdmin(host.id)) {
    return redirect(res, getDashboardRoute(host, 'incoming-contributions', { orderId: order.id }));
  }

  return redirect(res, `${await getCollectivePageRoute(order.collective)}/orders/${order.id}`);
};

export const handleTransaction: Handler = async (req, res) => {
  const transaction = await models.Transaction.findOne({
    where: { publicId: req.params.id },
    include: [
      { model: models.Collective, as: 'collective', required: true },
      { model: models.Collective, as: 'host', required: false },
      { model: models.Collective, as: 'fromCollective' },
    ],
  });
  if (!transaction) {
    return handleNotFound(req, res);
  }

  if (transaction.host && req.remoteUser && req.remoteUser.isAdmin(transaction.host.id)) {
    return redirect(
      res,
      getDashboardRoute(transaction.host, 'host-transactions', { openTransactionId: transaction.id }),
    );
  }

  if (transaction.ExpenseId) {
    req.params.id = await models.Expense.findByPk(transaction.ExpenseId).then(expense => expense?.publicId);
    return handleExpense(req, res);
  } else if (transaction.OrderId) {
    req.params.id = await models.Order.findByPk(transaction.OrderId).then(order => order?.publicId);
    return handleOrder(req, res);
  }

  return redirect(res, `${await getCollectivePageRoute(transaction.collective)}/transactions`);
};

export const handleAccountingCategory: Handler = async (req, res) => {
  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  const category = await models.AccountingCategory.findOne({
    where: { publicId: req.params.id },
    include: [{ model: models.Collective, as: 'collective', required: true }],
  });
  if (!category) {
    return handleNotFound(req, res);
  }

  if (req.remoteUser.isAdmin(category.collective.id)) {
    return redirect(res, getDashboardRoute(category.collective, 'chart-of-accounts'));
  }

  return handleAccessDenied(req, res);
};

export const handleConnectedAccount: Handler = async (req, res) => {
  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  const connectedAccount = await models.ConnectedAccount.findOne({
    where: { publicId: req.params.id },
    include: [{ model: models.Collective, as: 'collective', required: true }],
  });
  if (!connectedAccount) {
    return handleNotFound(req, res);
  }

  if (req.remoteUser.isAdmin(connectedAccount.collective.id)) {
    return redirect(res, getDashboardRoute(connectedAccount.collective, 'overview'));
  }

  return handleAccessDenied(req, res);
};

export const handlePaymentMethod: Handler = async (req, res) => {
  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  const paymentMethod = await models.PaymentMethod.findOne({
    where: { publicId: req.params.id },
    include: [{ model: models.Collective, as: 'Collective', required: true }],
  });
  if (!paymentMethod) {
    return handleNotFound(req, res);
  }

  if (req.remoteUser.isAdmin(paymentMethod.Collective.id)) {
    return redirect(res, getDashboardRoute(paymentMethod.Collective, 'payment-methods'));
  }

  return handleAccessDenied(req, res);
};

export const handlePayoutMethod: Handler = async (req, res) => {
  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  const payoutMethod = await models.PayoutMethod.findOne({
    where: { publicId: req.params.id },
    include: [{ model: models.Collective, as: 'Collective', required: true }],
  });
  if (!payoutMethod) {
    return handleNotFound(req, res);
  }

  if (req.remoteUser.isAdmin(payoutMethod.Collective.id)) {
    return redirect(res, getDashboardRoute(payoutMethod.Collective, 'payment-methods'));
  }

  return handleAccessDenied(req, res);
};

export const handleLegalDocument: Handler = async (req, res) => {
  if (!req.remoteUser) {
    return handleUnauthorized(req, res);
  }

  const legalDocument = await models.LegalDocument.findOne({
    where: { publicId: req.params.id },
    include: [{ model: models.Collective, as: 'collective', required: true }],
  });
  if (!legalDocument) {
    return handleNotFound(req, res);
  }

  if (req.remoteUser.isAdmin(legalDocument.collective.id)) {
    return redirect(res, getDashboardRoute(legalDocument.collective, 'tax-information'));
  }

  return handleAccessDenied(req, res);
};

export const handleVirtualCard: Handler = async (req, res) => {
  return handleNotFound(req, res);
};

export const handleVirtualCardRequest: Handler = async (req, res) => {
  return handleNotFound(req, res);
};

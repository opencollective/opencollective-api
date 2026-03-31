import express from 'express';

import { handleNotFound } from './entity-handlers/common';
import {
  handleAccountingCategory,
  handleActivity,
  handleApplication,
  handleCollective,
  handleComment,
  handleConnectedAccount,
  handleConversation,
  handleExpense,
  handleExportRequest,
  handleHostApplication,
  handleLegalDocument,
  handleMember,
  handleMemberInvitation,
  handleOrder,
  handlePaymentMethod,
  handlePayoutMethod,
  handlePersonalToken,
  handleTier,
  handleTransaction,
  handleUpdate,
  handleUser,
  handleUserToken,
  handleUserTwoFactorMethod,
  handleVirtualCard,
  handleVirtualCardRequest,
} from './entity-handlers/handlers';
import { type Handler } from './entity-handlers/utils';
import { EntityShortIdPrefix, getEntityShortIdPrefix } from './entity-map';

const handlerMap: Record<EntityShortIdPrefix, Handler> = {
  [EntityShortIdPrefix.AccountingCategory]: handleAccountingCategory,
  [EntityShortIdPrefix.Activity]: handleActivity,
  [EntityShortIdPrefix.Agreement]: handleNotFound,
  [EntityShortIdPrefix.Application]: handleApplication,
  [EntityShortIdPrefix.Comment]: handleComment,
  [EntityShortIdPrefix.Collective]: handleCollective,
  [EntityShortIdPrefix.ConnectedAccount]: handleConnectedAccount,
  [EntityShortIdPrefix.Conversation]: handleConversation,
  [EntityShortIdPrefix.Expense]: handleExpense,
  [EntityShortIdPrefix.ExpenseAttachedFile]: handleNotFound,
  [EntityShortIdPrefix.ExpenseItem]: handleNotFound,
  [EntityShortIdPrefix.ExportRequest]: handleExportRequest,
  [EntityShortIdPrefix.HostApplication]: handleHostApplication,
  [EntityShortIdPrefix.KYCVerification]: handleNotFound,
  [EntityShortIdPrefix.LegalDocument]: handleLegalDocument,
  [EntityShortIdPrefix.ManualPaymentProvider]: handleNotFound,
  [EntityShortIdPrefix.Member]: handleMember,
  [EntityShortIdPrefix.MemberInvitation]: handleMemberInvitation,
  [EntityShortIdPrefix.ActivitySubscription]: handleNotFound,
  [EntityShortIdPrefix.OAuthAuthorizationCode]: handleNotFound,
  [EntityShortIdPrefix.Order]: handleOrder,
  [EntityShortIdPrefix.PayoutMethod]: handlePayoutMethod,
  [EntityShortIdPrefix.PaymentMethod]: handlePaymentMethod,
  [EntityShortIdPrefix.PersonalToken]: handlePersonalToken,
  [EntityShortIdPrefix.RecurringExpense]: handleNotFound,
  [EntityShortIdPrefix.Tier]: handleTier,
  [EntityShortIdPrefix.Transaction]: handleTransaction,
  [EntityShortIdPrefix.TransactionsImport]: handleNotFound,
  [EntityShortIdPrefix.TransactionsImportRow]: handleNotFound,
  [EntityShortIdPrefix.Update]: handleUpdate,
  [EntityShortIdPrefix.UploadedFile]: handleNotFound,
  [EntityShortIdPrefix.User]: handleUser,
  [EntityShortIdPrefix.UserToken]: handleUserToken,
  [EntityShortIdPrefix.UserTwoFactorMethod]: handleUserTwoFactorMethod,
  [EntityShortIdPrefix.VirtualCard]: handleVirtualCard,
  [EntityShortIdPrefix.VirtualCardRequest]: handleVirtualCardRequest,
};

export async function handlePermalink(req: express.Request, res: express.Response) {
  const prefix = getEntityShortIdPrefix(req.params.id);
  if (!prefix) {
    return handleNotFound(req, res);
  }

  const handler = handlerMap[prefix];
  if (!handler) {
    return handleNotFound(req, res);
  }

  return handler(req, res);
}

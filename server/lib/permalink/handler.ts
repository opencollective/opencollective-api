import express from 'express';

import { handleNotFound } from './entity-handlers/common';
import {
  handleAccountingCategory,
  handleAccountingCategoryRule,
  handleActivity,
  handleAgreement,
  handleApplication,
  handleCollective,
  handleComment,
  handleConnectedAccount,
  handleConversation,
  handleExpense,
  handleExpenseAttachedFile,
  handleExpenseItem,
  handleExportRequest,
  handleHostApplication,
  handleKYCVerification,
  handleLegalDocument,
  handleManualPaymentProvider,
  handleMember,
  handleMemberInvitation,
  handleNotification,
  handleOAuthAuthorizationCode,
  handleOrder,
  handlePaymentMethod,
  handlePayoutMethod,
  handlePersonalToken,
  handleRecurringExpense,
  handleTier,
  handleTransaction,
  handleTransactionsImport,
  handleTransactionsImportRow,
  handleUpdate,
  handleUploadedFile,
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
  [EntityShortIdPrefix.Agreement]: handleAgreement,
  [EntityShortIdPrefix.Application]: handleApplication,
  [EntityShortIdPrefix.Comment]: handleComment,
  [EntityShortIdPrefix.Collective]: handleCollective,
  [EntityShortIdPrefix.ConnectedAccount]: handleConnectedAccount,
  [EntityShortIdPrefix.Conversation]: handleConversation,
  [EntityShortIdPrefix.Expense]: handleExpense,
  [EntityShortIdPrefix.ExpenseAttachedFile]: handleExpenseAttachedFile,
  [EntityShortIdPrefix.ExpenseItem]: handleExpenseItem,
  [EntityShortIdPrefix.ExportRequest]: handleExportRequest,
  [EntityShortIdPrefix.HostApplication]: handleHostApplication,
  [EntityShortIdPrefix.KYCVerification]: handleKYCVerification,
  [EntityShortIdPrefix.LegalDocument]: handleLegalDocument,
  [EntityShortIdPrefix.ManualPaymentProvider]: handleManualPaymentProvider,
  [EntityShortIdPrefix.Member]: handleMember,
  [EntityShortIdPrefix.MemberInvitation]: handleMemberInvitation,
  [EntityShortIdPrefix.Notification]: handleNotification,
  [EntityShortIdPrefix.OAuthAuthorizationCode]: handleOAuthAuthorizationCode,
  [EntityShortIdPrefix.Order]: handleOrder,
  [EntityShortIdPrefix.PayoutMethod]: handlePayoutMethod,
  [EntityShortIdPrefix.PaymentMethod]: handlePaymentMethod,
  [EntityShortIdPrefix.PersonalToken]: handlePersonalToken,
  [EntityShortIdPrefix.RecurringExpense]: handleRecurringExpense,
  [EntityShortIdPrefix.Tier]: handleTier,
  [EntityShortIdPrefix.Transaction]: handleTransaction,
  [EntityShortIdPrefix.TransactionsImport]: handleTransactionsImport,
  [EntityShortIdPrefix.TransactionsImportRow]: handleTransactionsImportRow,
  [EntityShortIdPrefix.Update]: handleUpdate,
  [EntityShortIdPrefix.UploadedFile]: handleUploadedFile,
  [EntityShortIdPrefix.User]: handleUser,
  [EntityShortIdPrefix.UserToken]: handleUserToken,
  [EntityShortIdPrefix.UserTwoFactorMethod]: handleUserTwoFactorMethod,
  [EntityShortIdPrefix.VirtualCard]: handleVirtualCard,
  [EntityShortIdPrefix.VirtualCardRequest]: handleVirtualCardRequest,
  [EntityShortIdPrefix.AccountingCategoryRule]: handleAccountingCategoryRule,
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

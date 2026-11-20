/**
 * Typed access to the expense payment rules.
 *
 * The rules themselves are written in Bend (`./expense-payments.bend`), where they are proven to obey the laws
 * in `/LAWS.bend`, and compiled to `./generated/expense-payments.mjs`. This file only translates values at the
 * boundary: it must never decide anything, or the decision would escape the laws. See `docs/bend-laws.md`.
 */

/* eslint-disable camelcase -- field names are the ones declared in the Bend source */

import ExpenseStatuses from '../constants/expense-status';
import ExpenseTypes from '../constants/expense-type';

import generatedKernel from './generated/expense-payments.mjs';
import { toBendBool, toBendConstructor } from './interop';

/** What the decision needs from the request and the expense alone */
export type ExpensePaymentFacts = {
  /** A session, or a token that carries the `expenses` scope */
  hasExpensesScope: boolean;
  type: ExpenseTypes | `${ExpenseTypes}`;
  /** A CHARGE entered by hand rather than by a card processor */
  isManuallyCreatedCharge: boolean;
  status: ExpenseStatuses | `${ExpenseStatuses}`;
  /** The user is signed in and neither suspended nor limited */
  canUseExpenses: boolean;
};

/** What the decision needs once the fiscal host of the expense is loaded */
export type HostPaymentFacts = {
  isBlockedForUnpaidBilling: boolean;
  isAuthenticated: boolean;
  isHostAdmin: boolean;
};

/** Mirrors `DenyReason` in `expense-payments.bend` */
export type PaymentDenialReason =
  | 'InvalidScope'
  | 'ChargeNotPayable'
  | 'UnsupportedStatus'
  | 'UserFeatureDisabled'
  | 'HostBlocked'
  | 'UserRequired'
  | 'NotHostAdmin';

export type PaymentVerdict = { allowed: true } | { allowed: false; reason: PaymentDenialReason };

// The `Record` types make TypeScript refuse a new status or type that has no Bend counterpart. The names on the
// right are checked against the Bend source in `test/server/bend/expense-payments.test.ts`.

const BEND_EXPENSE_TYPES: Record<ExpenseTypes, string> = {
  [ExpenseTypes.INVOICE]: 'Invoice',
  [ExpenseTypes.RECEIPT]: 'Receipt',
  [ExpenseTypes.FUNDING_REQUEST]: 'FundingRequest',
  [ExpenseTypes.GRANT]: 'Grant',
  [ExpenseTypes.UNCLASSIFIED]: 'Unclassified',
  [ExpenseTypes.CHARGE]: 'Charge',
  [ExpenseTypes.SETTLEMENT]: 'Settlement',
  [ExpenseTypes.PLATFORM_BILLING]: 'PlatformBilling',
};

const BEND_EXPENSE_STATUSES: Record<ExpenseStatuses, string> = {
  [ExpenseStatuses.DRAFT]: 'Draft',
  [ExpenseStatuses.UNVERIFIED]: 'Unverified',
  [ExpenseStatuses.PENDING]: 'Pending',
  [ExpenseStatuses.INCOMPLETE]: 'Incomplete',
  [ExpenseStatuses.APPROVED]: 'Approved',
  [ExpenseStatuses.REJECTED]: 'Rejected',
  [ExpenseStatuses.PROCESSING]: 'Processing',
  [ExpenseStatuses.ERROR]: 'Error',
  [ExpenseStatuses.PAID]: 'Paid',
  [ExpenseStatuses.SCHEDULED_FOR_PAYMENT]: 'ScheduledForPayment',
  [ExpenseStatuses.SPAM]: 'Spam',
  [ExpenseStatuses.CANCELED]: 'Canceled',
  [ExpenseStatuses.INVITE_DECLINED]: 'InviteDeclined',
};

const PAYMENT_DENIAL_REASONS: readonly PaymentDenialReason[] = [
  'InvalidScope',
  'ChargeNotPayable',
  'UnsupportedStatus',
  'UserFeatureDisabled',
  'HostBlocked',
  'UserRequired',
  'NotHostAdmin',
];

/** Exposed for the test that keeps these names in sync with the Bend source */
export const BEND_EXPENSE_PAYMENT_NAMES = {
  ExpenseType: Object.values(BEND_EXPENSE_TYPES),
  ExpenseStatus: Object.values(BEND_EXPENSE_STATUSES),
  DenyReason: PAYMENT_DENIAL_REASONS,
};

type BendVerdict = { $: 'Allow' } | { $: 'Deny'; reason: { $: string } };

const kernel = generatedKernel as {
  screen: (expenseFacts: unknown) => BendVerdict;
  mark_as_paid: (expenseFacts: unknown, hostFacts: unknown) => BendVerdict;
  pay: (expenseFacts: unknown, hostFacts: unknown) => BendVerdict;
};

const toBendExpenseFacts = (facts: ExpensePaymentFacts) => ({
  $: 'ExpenseFacts',
  has_expenses_scope: toBendBool(facts.hasExpensesScope, 'hasExpensesScope'),
  expense_type: toBendConstructor(BEND_EXPENSE_TYPES, facts.type, 'expense type'),
  manually_created_charge: toBendBool(facts.isManuallyCreatedCharge, 'isManuallyCreatedCharge'),
  status: toBendConstructor(BEND_EXPENSE_STATUSES, facts.status, 'expense status'),
  can_use_expenses: toBendBool(facts.canUseExpenses, 'canUseExpenses'),
});

const toBendHostFacts = (facts: HostPaymentFacts) => ({
  $: 'HostFacts',
  blocked_for_unpaid_billing: toBendBool(facts.isBlockedForUnpaidBilling, 'isBlockedForUnpaidBilling'),
  authenticated: toBendBool(facts.isAuthenticated, 'isAuthenticated'),
  host_admin: toBendBool(facts.isHostAdmin, 'isHostAdmin'),
});

const fromBendVerdict = (verdict: BendVerdict): PaymentVerdict => {
  if (verdict.$ === 'Allow') {
    return { allowed: true };
  } else if (verdict.$ === 'Deny' && PAYMENT_DENIAL_REASONS.includes(verdict.reason.$ as PaymentDenialReason)) {
    return { allowed: false, reason: verdict.reason.$ as PaymentDenialReason };
  } else {
    throw new Error(`Unexpected verdict from the expense payments kernel: ${JSON.stringify(verdict)}`);
  }
};

/**
 * The checks that need no host. A denial here is final (laws `screening_is_final_*`), so the host does not need to
 * be loaded; an approval only means the host checks must run.
 */
export const screenExpensePayment = (facts: ExpensePaymentFacts): PaymentVerdict => {
  return fromBendVerdict(kernel.screen(toBendExpenseFacts(facts)));
};

/** Whether the expense can be recorded as paid, without sending money through a payment provider */
export const decideMarkExpenseAsPaid = (facts: ExpensePaymentFacts, hostFacts: HostPaymentFacts): PaymentVerdict => {
  return fromBendVerdict(kernel.mark_as_paid(toBendExpenseFacts(facts), toBendHostFacts(hostFacts)));
};

/** Whether the payment of the expense can be triggered */
export const decidePayExpense = (facts: ExpensePaymentFacts, hostFacts: HostPaymentFacts): PaymentVerdict => {
  return fromBendVerdict(kernel.pay(toBendExpenseFacts(facts), toBendHostFacts(hostFacts)));
};

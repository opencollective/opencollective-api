# Expense payments: who may pay an expense, and when.
#
# This file is the decision itself, not a model of it: `npm run bend:build`
# compiles it to generated/expense-payments.mjs, which `canPayExpense` and
# `canMarkAsPaid` (server/graphql/common/expenses.ts) call through the typed
# wrapper in ./expense-payments.ts. The laws it must obey are in /LAWS.bend and
# their proofs in /PROOF.bend; `npm run bend:check` checks them.
#
# It is pure: the TypeScript side loads the facts (scope, expense, host, roles)
# and maps a denial to the error it throws. Nothing here touches the database.

import Base

# Mirrors server/constants/expense-type.ts
type ExpenseType is Data:
  Invoice{}
  Receipt{}
  FundingRequest{}
  Grant{}
  Unclassified{}
  Charge{}
  Settlement{}
  PlatformBilling{}

# Mirrors server/constants/expense-status.ts
type ExpenseStatus is Data:
  Draft{}
  Unverified{}
  Pending{}
  Incomplete{}
  Approved{}
  Rejected{}
  Processing{}
  Error{}
  Paid{}
  ScheduledForPayment{}
  Spam{}
  Canceled{}
  InviteDeclined{}

# What is known from the request and the expense alone, without loading the host.
#   has_expenses_scope:      a session, or a token that carries the `expenses` scope
#   manually_created_charge: a CHARGE entered by hand rather than by a card processor
#   can_use_expenses:        the user is signed in and not suspended or limited
type ExpenseFacts is Data:
  ExpenseFacts{has_expenses_scope: Bool, expense_type: ExpenseType, manually_created_charge: Bool, status: ExpenseStatus, can_use_expenses: Bool}

# What needs the expense's fiscal host to be loaded.
#   blocked_for_unpaid_billing: the host has unpaid platform bills
#   host_admin:                 the user is an admin of the expense's fiscal host
type HostFacts is Data:
  HostFacts{blocked_for_unpaid_billing: Bool, authenticated: Bool, host_admin: Bool}

type DenyReason is Data:
  InvalidScope{}
  ChargeNotPayable{}
  UnsupportedStatus{}
  UserFeatureDisabled{}
  HostBlocked{}
  UserRequired{}
  NotHostAdmin{}

type Verdict is Data:
  Allow{}
  Deny{reason: DenyReason}

# Accessors, so that laws can name a fact instead of a position
# -------------------------------------------------------------

def has_expenses_scope(e: ExpenseFacts) -> Bool:
  match e:
    case ExpenseFacts{scope, _, _, _, _}:
      scope

def type_of(e: ExpenseFacts) -> ExpenseType:
  match e:
    case ExpenseFacts{_, expense_type, _, _, _}:
      expense_type

def is_manually_created_charge(e: ExpenseFacts) -> Bool:
  match e:
    case ExpenseFacts{_, _, manual, _, _}:
      manual

def status_of(e: ExpenseFacts) -> ExpenseStatus:
  match e:
    case ExpenseFacts{_, _, _, status, _}:
      status

def can_use_expenses(e: ExpenseFacts) -> Bool:
  match e:
    case ExpenseFacts{_, _, _, _, can_use}:
      can_use

def is_blocked_for_unpaid_billing(h: HostFacts) -> Bool:
  match h:
    case HostFacts{blocked, _, _}:
      blocked

def is_authenticated(h: HostFacts) -> Bool:
  match h:
    case HostFacts{_, authenticated, _}:
      authenticated

def is_host_admin(h: HostFacts) -> Bool:
  match h:
    case HostFacts{_, _, host_admin}:
      host_admin

# Classifications
# ---------------

def is_charge(t: ExpenseType) -> Bool:
  match t:
    case Charge{}:
      True{}
    case _:
      False{}

# Expenses the platform bills to a host: a host with unpaid bills may still pay these.
def is_platform_expense(t: ExpenseType) -> Bool:
  match t:
    case Settlement{}:
      True{}
    case PlatformBilling{}:
      True{}
    case _:
      False{}

def is_payable_status(s: ExpenseStatus) -> Bool:
  match s:
    case Approved{}:
      True{}
    case Error{}:
      True{}
    case _:
      False{}

# Decisions
# ---------

def screen_checks(scope: Bool, card_charge: Bool, payable: Bool, can_use: Bool) -> Verdict:
  match scope card_charge payable can_use:
    case False{} _ _ _:
      Deny{InvalidScope{}}
    case True{} True{} _ _:
      Deny{ChargeNotPayable{}}
    case True{} False{} False{} _:
      Deny{UnsupportedStatus{}}
    case True{} False{} True{} False{}:
      Deny{UserFeatureDisabled{}}
    case True{} False{} True{} True{}:
      Allow{}

# The checks that need no host. A denial here is final (laws `screening_is_final_*`),
# so the caller may skip loading the host.
def screen(e: ExpenseFacts) -> Verdict:
  match e:
    case ExpenseFacts{scope, expense_type, manual, status, can_use}:
      screen_checks(scope, Bool.and(is_charge(expense_type), Bool.not(manual)), is_payable_status(status), can_use)

def host_checks(blocked: Bool, authenticated: Bool, host_admin: Bool) -> Verdict:
  match blocked authenticated host_admin:
    case True{} _ _:
      Deny{HostBlocked{}}
    case False{} False{} _:
      Deny{UserRequired{}}
    case False{} True{} False{}:
      Deny{NotHostAdmin{}}
    case False{} True{} True{}:
      Allow{}

def check_host(expense_type: ExpenseType, h: HostFacts) -> Verdict:
  match h:
    case HostFacts{blocked, authenticated, host_admin}:
      host_checks(Bool.and(blocked, Bool.not(is_platform_expense(expense_type))), authenticated, host_admin)

def after_screening(screening: Verdict, expense_type: ExpenseType, h: HostFacts) -> Verdict:
  match screening:
    case Deny{reason}:
      Deny{reason}
    case Allow{}:
      check_host(expense_type, h)

# May the user record the expense as paid, adding it to the ledger without
# sending money through a payment provider?
def mark_as_paid(+e: ExpenseFacts, h: HostFacts) -> Verdict:
  after_screening(screen(e), type_of(e), h)

def reject_charges(marking: Verdict, charge: Bool) -> Verdict:
  match marking charge:
    case Deny{reason} _:
      Deny{reason}
    case Allow{} True{}:
      Deny{ChargeNotPayable{}}
    case Allow{} False{}:
      Allow{}

# May the user trigger the payment of the expense? A charge records a payment
# that already happened elsewhere, so it is never paid again.
def pay(+e: ExpenseFacts, h: HostFacts) -> Verdict:
  reject_charges(mark_as_paid(e, h), is_charge(type_of(e)))

# The laws of Open Collective.
#
# Each law is a rule that must hold for every possible input, not only for the
# cases a test happens to try. Humans write this file; `PROOF.bend` proves each
# law against the code in server/bend/, and `npm run bend:check` refuses a change
# that breaks one. See docs/bend-laws.md.

import Base
import ./server/bend/expense-payments.bend as Pay
import ./server/bend/graphql-v1-auth.bend as V1
import ./server/bend/payout-rolling-limit.bend as Limit

# Expense payments
# ================

# LAW: expense payments can only be triggered by host admins.
law only_host_admins_can_pay_expenses:
  for +e: Pay.ExpenseFacts
  for +h: Pay.HostFacts
  for allowed: {Pay.pay(e, h) == Pay.Allow{} : Pay.Verdict}
  {Pay.is_host_admin(h) == True{} : Bool}

# LAW: only host admins can record an expense as paid.
law only_host_admins_can_mark_expenses_as_paid:
  for +e: Pay.ExpenseFacts
  for +h: Pay.HostFacts
  for allowed: {Pay.mark_as_paid(e, h) == Pay.Allow{} : Pay.Verdict}
  {Pay.is_host_admin(h) == True{} : Bool}

# LAW: an expense is only paid once approved, or to retry a payment that failed.
law only_approved_or_errored_expenses_are_paid:
  for +e: Pay.ExpenseFacts
  for +h: Pay.HostFacts
  for allowed: {Pay.mark_as_paid(e, h) == Pay.Allow{} : Pay.Verdict}
  {Pay.status_of(e) == Pay.Approved{} : Pay.ExpenseStatus} | {Pay.status_of(e) == Pay.Error{} : Pay.ExpenseStatus}

# LAW: a charge is never paid: it records a payment that already happened.
law charges_are_never_paid:
  for +e: Pay.ExpenseFacts
  for +h: Pay.HostFacts
  for charge: {Pay.type_of(e) == Pay.Charge{} : Pay.ExpenseType}
  {Pay.pay(e, h) != Pay.Allow{} : Pay.Verdict}

# LAW: a charge made by a card processor cannot be recorded as paid by hand.
law card_charges_are_never_marked_as_paid:
  for +e: Pay.ExpenseFacts
  for +h: Pay.HostFacts
  for charge: {Pay.type_of(e) == Pay.Charge{} : Pay.ExpenseType}
  for by_card: {Pay.is_manually_created_charge(e) == False{} : Bool}
  {Pay.mark_as_paid(e, h) != Pay.Allow{} : Pay.Verdict}

# LAW: a token without the `expenses` scope is refused for that reason alone,
# whatever else is true: the answer reveals nothing about the expense.
law tokens_without_the_expenses_scope_cannot_pay:
  for +e: Pay.ExpenseFacts
  for +h: Pay.HostFacts
  for no_scope: {Pay.has_expenses_scope(e) == False{} : Bool}
  {Pay.mark_as_paid(e, h) == Pay.Deny{Pay.InvalidScope{}} : Pay.Verdict}

# LAW: a signed-out visitor can never pay.
law guests_cannot_pay_expenses:
  for +e: Pay.ExpenseFacts
  for +h: Pay.HostFacts
  for guest: {Pay.is_authenticated(h) == False{} : Bool}
  {Pay.mark_as_paid(e, h) != Pay.Allow{} : Pay.Verdict}

# LAW: a suspended or limited user can never pay, host admin or not.
law limited_users_cannot_pay_expenses:
  for +e: Pay.ExpenseFacts
  for +h: Pay.HostFacts
  for limited: {Pay.can_use_expenses(e) == False{} : Bool}
  {Pay.mark_as_paid(e, h) != Pay.Allow{} : Pay.Verdict}

# LAW: a host with unpaid platform bills can only pay what it owes the platform.
law hosts_with_unpaid_bills_only_pay_the_platform:
  for +e: Pay.ExpenseFacts
  for +h: Pay.HostFacts
  for blocked: {Pay.is_blocked_for_unpaid_billing(h) == True{} : Bool}
  for allowed: {Pay.mark_as_paid(e, h) == Pay.Allow{} : Pay.Verdict}
  {Pay.type_of(e) == Pay.Settlement{} : Pay.ExpenseType} | {Pay.type_of(e) == Pay.PlatformBilling{} : Pay.ExpenseType}

# LAW: whoever may pay an expense may also record it as paid.
law paying_requires_the_right_to_mark_as_paid:
  for +e: Pay.ExpenseFacts
  for +h: Pay.HostFacts
  for allowed: {Pay.pay(e, h) == Pay.Allow{} : Pay.Verdict}
  {Pay.mark_as_paid(e, h) == Pay.Allow{} : Pay.Verdict}

# LAW: the rules still let a payment through. A host admin of a host in good
# standing, with the scope, can pay an approved invoice.
law host_admins_can_pay_approved_invoices:
  {Pay.pay(Pay.ExpenseFacts{True{}, Pay.Invoice{}, False{}, Pay.Approved{}, True{}}, Pay.HostFacts{False{}, True{}, True{}}) == Pay.Allow{} : Pay.Verdict}

# LAW: a denial that needs no host is final. The API relies on this to answer
# without loading the host.
law screening_is_final_when_marking_as_paid:
  for +e: Pay.ExpenseFacts
  for +h: Pay.HostFacts
  for +reason: Pay.DenyReason
  for screened: {Pay.screen(e) == Pay.Deny{reason} : Pay.Verdict}
  {Pay.mark_as_paid(e, h) == Pay.Deny{reason} : Pay.Verdict}

law screening_is_final_when_paying:
  for +e: Pay.ExpenseFacts
  for +h: Pay.HostFacts
  for +reason: Pay.DenyReason
  for screened: {Pay.screen(e) == Pay.Deny{reason} : Pay.Verdict}
  {Pay.pay(e, h) == Pay.Deny{reason} : Pay.Verdict}

# GraphQL v1
# ==========

# LAW: an OAuth token is only accepted on GraphQL v1 if its application is allow-listed.
law oauth_tokens_need_an_allow_listed_application_on_v1:
  for +r: V1.Request
  for oauth: {V1.uses_oauth_token(r) == True{} : Bool}
  for accepted: {V1.gate(r) == V1.Accept{} : V1.Verdict}
  {V1.oauth_app_is_allow_listed(r) == True{} : Bool}

# LAW: a personal token is only accepted on GraphQL v1 if it is allow-listed.
law personal_tokens_need_to_be_allow_listed_on_v1:
  for +r: V1.Request
  for personal: {V1.uses_personal_token(r) == True{} : Bool}
  for accepted: {V1.gate(r) == V1.Accept{} : V1.Verdict}
  {V1.personal_token_is_allow_listed(r) == True{} : Bool}

# LAW: a request without any token is always accepted: sessions and guests are
# not this gate's concern.
law requests_without_tokens_pass_the_v1_gate:
  for +r: V1.Request
  for no_oauth: {V1.uses_oauth_token(r) == False{} : Bool}
  for no_personal: {V1.uses_personal_token(r) == False{} : Bool}
  {V1.gate(r) == V1.Accept{} : V1.Verdict}

# Payouts: the two-factor rolling limit
# =====================================
#
# These laws have no bound on their inputs: any amounts, any number of payouts.

# LAW: however many payouts are made, and whatever their amounts, the total paid
# without a 2FA token since the last one never exceeds the host's rolling limit.
law no_sequence_of_payouts_exceeds_the_rolling_limit:
  for +amounts: +List<Nat>
  for +limit: Nat
  for +paid: +Maybe<Nat>
  for starts_within: {Limit.is_within(limit, paid) == True{} : Bool}
  {Limit.is_within(limit, Limit.replay(amounts, limit, paid)) == True{} : Bool}

# LAW: a payout made without a token is counted in full: no amount escapes the total.
law payouts_without_a_token_are_counted_in_full:
  for +limit: Nat
  for +total: Nat
  for +amount: Nat
  for no_token: {Limit.asks_for_token(Limit.decide(limit, Some{total}, amount)) == False{} : Bool}
  {Limit.paid_since_token(Limit.decide(limit, Some{total}, amount)) == Nat.add(total, amount) : Nat}

# LAW: a payout above the limit always needs a token, whatever was paid before.
law payouts_above_the_limit_always_need_a_token:
  for +limit: Nat
  for +paid: +Maybe<Nat>
  for +amount: Nat
  for above: {Nat.is_le(amount, limit) == False{} : Bool}
  {Limit.asks_for_token(Limit.decide(limit, paid, amount)) == True{} : Bool}

# LAW: the first payout always needs a token.
law the_first_payout_always_needs_a_token:
  for +limit: Nat
  for +amount: Nat
  {Limit.asks_for_token(Limit.decide(limit, None{}, amount)) == True{} : Bool}

# LAW: a token is not asked for nothing. A payout that fits in what remains of
# the limit goes through without one.
law payouts_within_the_limit_need_no_token:
  for +limit: Nat
  for +total: Nat
  for +amount: Nat
  for fits: {Nat.is_le(Nat.add(total, amount), limit) == True{} : Bool}
  {Limit.asks_for_token(Limit.decide(limit, Some{total}, amount)) == False{} : Bool}

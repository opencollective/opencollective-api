# Proofs of the laws in LAWS.bend, written and maintained by the AI.
#
# `npm run bend:check` (bend PROOF.bend) prints ALL PROOFS CHECK once every law
# holds. Do not weaken a law to make a proof pass: fix the code in server/bend/.

import Base
import ./server/bend/expense-payments.bend as Pay
import ./server/bend/graphql-v1-auth.bend as V1
import ./server/bend/payout-rolling-limit.bend as Limit
import ./LAWS.bend as Laws

# Contradictions
# ==============

# Sends True to Unit and False to Empty: an equation between them is absurd.
def IsTrue(b: Bool) -> Type:
  match b:
    case True{}:
      Unit
    case False{}:
      Empty

def true_is_not_false(e: {True{} == False{} : Bool}) -> Empty:
  %e : IsTrue(_)
  Unit{}

# Sends Deny to Unit and Allow to Empty.
def IsDeny(v: Pay.Verdict) -> Type:
  match v:
    case Pay.Allow{}:
      Empty
    case Pay.Deny{reason}:
      Unit

def deny_is_not_allow(-reason: Pay.DenyReason, e: {Pay.Deny{reason} == Pay.Allow{} : Pay.Verdict}) -> Empty:
  %e : IsDeny(_)
  Unit{}

def false_is_not_true(e: {False{} == True{} : Bool}) -> Empty:
  true_is_not_false(Equal.sym(Bool, False{}, True{}, e))

# A fact cannot be both true and false.
def contradiction(-b: Bool, yes: {b == True{} : Bool}, no: {b == False{} : Bool}) -> Empty:
  true_is_not_false(Equal.trans(Bool, True{}, b, False{}, Equal.sym(Bool, b, True{}, yes), no))

# Sends Accept to Unit and both rejections to Empty.
def IsAccept(v: V1.Verdict) -> Type:
  match v:
    case V1.Accept{}:
      Unit
    case V1.RejectOAuthToken{}:
      Empty
    case V1.RejectPersonalToken{}:
      Empty

def oauth_rejection_is_not_accept(e: {V1.RejectOAuthToken{} == V1.Accept{} : V1.Verdict}) -> Empty:
  %Equal.sym(V1.Verdict, V1.RejectOAuthToken{}, V1.Accept{}, e) : IsAccept(_)
  Unit{}

def personal_rejection_is_not_accept(e: {V1.RejectPersonalToken{} == V1.Accept{} : V1.Verdict}) -> Empty:
  %Equal.sym(V1.Verdict, V1.RejectPersonalToken{}, V1.Accept{}, e) : IsAccept(_)
  Unit{}

# Expense payments: what each stage lets through
# ==============================================

def host_checks_need_host_admin(blocked: Bool, authenticated: Bool, host_admin: Bool) -> {Pay.host_checks(blocked, authenticated, host_admin) == Pay.Allow{} : Pay.Verdict} -> {host_admin == True{} : Bool}:
  match blocked authenticated host_admin:
    case True{} _ _:
      e => Empty.absurd({host_admin == True{} : Bool}, deny_is_not_allow(Pay.HostBlocked{}, e))
    case False{} False{} _:
      e => Empty.absurd({host_admin == True{} : Bool}, deny_is_not_allow(Pay.UserRequired{}, e))
    case False{} True{} False{}:
      e => Empty.absurd({False{} == True{} : Bool}, deny_is_not_allow(Pay.NotHostAdmin{}, e))
    case False{} True{} True{}:
      e => {==}

def check_host_needs_host_admin(expense_type: Pay.ExpenseType, h: Pay.HostFacts) -> {Pay.check_host(expense_type, h) == Pay.Allow{} : Pay.Verdict} -> {Pay.is_host_admin(h) == True{} : Bool}:
  match h:
    case Pay.HostFacts{blocked, authenticated, host_admin}:
      host_checks_need_host_admin(Bool.and(blocked, Bool.not(Pay.is_platform_expense(expense_type))), authenticated, host_admin)

def allowed_after_screening_passed_host(screening: Pay.Verdict, expense_type: Pay.ExpenseType, h: Pay.HostFacts) -> {Pay.after_screening(screening, expense_type, h) == Pay.Allow{} : Pay.Verdict} -> {Pay.check_host(expense_type, h) == Pay.Allow{} : Pay.Verdict}:
  match screening:
    case Pay.Deny{reason}:
      e => Empty.absurd({Pay.check_host(expense_type, h) == Pay.Allow{} : Pay.Verdict}, deny_is_not_allow(reason, e))
    case Pay.Allow{}:
      e => e

def allowed_payment_was_marked(marking: Pay.Verdict, charge: Bool) -> {Pay.reject_charges(marking, charge) == Pay.Allow{} : Pay.Verdict} -> {marking == Pay.Allow{} : Pay.Verdict}:
  match marking charge:
    case Pay.Deny{reason} _:
      e => e
    case Pay.Allow{} True{}:
      e => {==}
    case Pay.Allow{} False{}:
      e => {==}

def host_checks_need_authentication(blocked: Bool, authenticated: Bool, host_admin: Bool) -> {Pay.host_checks(blocked, authenticated, host_admin) == Pay.Allow{} : Pay.Verdict} -> {authenticated == True{} : Bool}:
  match blocked authenticated host_admin:
    case True{} _ _:
      e => Empty.absurd({authenticated == True{} : Bool}, deny_is_not_allow(Pay.HostBlocked{}, e))
    case False{} False{} _:
      e => Empty.absurd({False{} == True{} : Bool}, deny_is_not_allow(Pay.UserRequired{}, e))
    case False{} True{} False{}:
      e => {==}
    case False{} True{} True{}:
      e => {==}

def host_checks_need_no_block(blocked: Bool, authenticated: Bool, host_admin: Bool) -> {Pay.host_checks(blocked, authenticated, host_admin) == Pay.Allow{} : Pay.Verdict} -> {blocked == False{} : Bool}:
  match blocked authenticated host_admin:
    case True{} _ _:
      e => Empty.absurd({True{} == False{} : Bool}, deny_is_not_allow(Pay.HostBlocked{}, e))
    case False{} False{} _:
      e => {==}
    case False{} True{} False{}:
      e => {==}
    case False{} True{} True{}:
      e => {==}

def check_host_needs_authentication(expense_type: Pay.ExpenseType, h: Pay.HostFacts) -> {Pay.check_host(expense_type, h) == Pay.Allow{} : Pay.Verdict} -> {Pay.is_authenticated(h) == True{} : Bool}:
  match h:
    case Pay.HostFacts{blocked, authenticated, host_admin}:
      host_checks_need_authentication(Bool.and(blocked, Bool.not(Pay.is_platform_expense(expense_type))), authenticated, host_admin)

# A host that passed is not blocked, unless the expense is owed to the platform.
def check_host_needs_no_block(expense_type: Pay.ExpenseType, h: Pay.HostFacts) -> {Pay.check_host(expense_type, h) == Pay.Allow{} : Pay.Verdict} -> {Bool.and(Pay.is_blocked_for_unpaid_billing(h), Bool.not(Pay.is_platform_expense(expense_type))) == False{} : Bool}:
  match h:
    case Pay.HostFacts{blocked, authenticated, host_admin}:
      host_checks_need_no_block(Bool.and(blocked, Bool.not(Pay.is_platform_expense(expense_type))), authenticated, host_admin)

def allowed_after_screening_passed_screening(screening: Pay.Verdict, expense_type: Pay.ExpenseType, h: Pay.HostFacts) -> {Pay.after_screening(screening, expense_type, h) == Pay.Allow{} : Pay.Verdict} -> {screening == Pay.Allow{} : Pay.Verdict}:
  match screening:
    case Pay.Deny{reason}:
      e => e
    case Pay.Allow{}:
      e => {==}

def allowed_payment_is_not_a_charge(marking: Pay.Verdict, charge: Bool) -> {Pay.reject_charges(marking, charge) == Pay.Allow{} : Pay.Verdict} -> {charge == False{} : Bool}:
  match marking charge:
    case Pay.Deny{reason} _:
      e => Empty.absurd({charge == False{} : Bool}, deny_is_not_allow(reason, e))
    case Pay.Allow{} True{}:
      e => Empty.absurd({True{} == False{} : Bool}, deny_is_not_allow(Pay.ChargeNotPayable{}, e))
    case Pay.Allow{} False{}:
      e => {==}

def screen_checks_need_no_card_charge(scope: Bool, card_charge: Bool, payable: Bool, can_use: Bool) -> {Pay.screen_checks(scope, card_charge, payable, can_use) == Pay.Allow{} : Pay.Verdict} -> {card_charge == False{} : Bool}:
  match scope card_charge payable can_use:
    case False{} _ _ _:
      e => Empty.absurd({card_charge == False{} : Bool}, deny_is_not_allow(Pay.InvalidScope{}, e))
    case True{} True{} _ _:
      e => Empty.absurd({True{} == False{} : Bool}, deny_is_not_allow(Pay.ChargeNotPayable{}, e))
    case True{} False{} False{} _:
      e => {==}
    case True{} False{} True{} False{}:
      e => {==}
    case True{} False{} True{} True{}:
      e => {==}

def screen_checks_need_payable_status(scope: Bool, card_charge: Bool, payable: Bool, can_use: Bool) -> {Pay.screen_checks(scope, card_charge, payable, can_use) == Pay.Allow{} : Pay.Verdict} -> {payable == True{} : Bool}:
  match scope card_charge payable can_use:
    case False{} _ _ _:
      e => Empty.absurd({payable == True{} : Bool}, deny_is_not_allow(Pay.InvalidScope{}, e))
    case True{} True{} _ _:
      e => Empty.absurd({payable == True{} : Bool}, deny_is_not_allow(Pay.ChargeNotPayable{}, e))
    case True{} False{} False{} _:
      e => Empty.absurd({False{} == True{} : Bool}, deny_is_not_allow(Pay.UnsupportedStatus{}, e))
    case True{} False{} True{} False{}:
      e => {==}
    case True{} False{} True{} True{}:
      e => {==}

def screen_checks_need_usable_expenses(scope: Bool, card_charge: Bool, payable: Bool, can_use: Bool) -> {Pay.screen_checks(scope, card_charge, payable, can_use) == Pay.Allow{} : Pay.Verdict} -> {can_use == True{} : Bool}:
  match scope card_charge payable can_use:
    case False{} _ _ _:
      e => Empty.absurd({can_use == True{} : Bool}, deny_is_not_allow(Pay.InvalidScope{}, e))
    case True{} True{} _ _:
      e => Empty.absurd({can_use == True{} : Bool}, deny_is_not_allow(Pay.ChargeNotPayable{}, e))
    case True{} False{} False{} _:
      e => Empty.absurd({can_use == True{} : Bool}, deny_is_not_allow(Pay.UnsupportedStatus{}, e))
    case True{} False{} True{} False{}:
      e => Empty.absurd({False{} == True{} : Bool}, deny_is_not_allow(Pay.UserFeatureDisabled{}, e))
    case True{} False{} True{} True{}:
      e => {==}

def screen_needs_no_card_charge(e: Pay.ExpenseFacts) -> {Pay.screen(e) == Pay.Allow{} : Pay.Verdict} -> {Bool.and(Pay.is_charge(Pay.type_of(e)), Bool.not(Pay.is_manually_created_charge(e))) == False{} : Bool}:
  match e:
    case Pay.ExpenseFacts{scope, expense_type, manual, status, can_use}:
      screen_checks_need_no_card_charge(scope, Bool.and(Pay.is_charge(expense_type), Bool.not(manual)), Pay.is_payable_status(status), can_use)

def screen_needs_payable_status(e: Pay.ExpenseFacts) -> {Pay.screen(e) == Pay.Allow{} : Pay.Verdict} -> {Pay.is_payable_status(Pay.status_of(e)) == True{} : Bool}:
  match e:
    case Pay.ExpenseFacts{scope, expense_type, manual, status, can_use}:
      screen_checks_need_payable_status(scope, Bool.and(Pay.is_charge(expense_type), Bool.not(manual)), Pay.is_payable_status(status), can_use)

def screen_needs_usable_expenses(e: Pay.ExpenseFacts) -> {Pay.screen(e) == Pay.Allow{} : Pay.Verdict} -> {Pay.can_use_expenses(e) == True{} : Bool}:
  match e:
    case Pay.ExpenseFacts{scope, expense_type, manual, status, can_use}:
      screen_checks_need_usable_expenses(scope, Bool.and(Pay.is_charge(expense_type), Bool.not(manual)), Pay.is_payable_status(status), can_use)

def not_a_payable_status(-status: Pay.ExpenseStatus, e: {False{} == True{} : Bool}) -> {status == Pay.Approved{} : Pay.ExpenseStatus} | {status == Pay.Error{} : Pay.ExpenseStatus}:
  Empty.absurd({status == Pay.Approved{} : Pay.ExpenseStatus} | {status == Pay.Error{} : Pay.ExpenseStatus}, false_is_not_true(e))

def payable_status_is_approved_or_error(status: Pay.ExpenseStatus) -> {Pay.is_payable_status(status) == True{} : Bool} -> {status == Pay.Approved{} : Pay.ExpenseStatus} | {status == Pay.Error{} : Pay.ExpenseStatus}:
  match status:
    case Pay.Draft{}:
      e => not_a_payable_status(Pay.Draft{}, e)
    case Pay.Unverified{}:
      e => not_a_payable_status(Pay.Unverified{}, e)
    case Pay.Pending{}:
      e => not_a_payable_status(Pay.Pending{}, e)
    case Pay.Incomplete{}:
      e => not_a_payable_status(Pay.Incomplete{}, e)
    case Pay.Approved{}:
      e => Inl{{==}}
    case Pay.Rejected{}:
      e => not_a_payable_status(Pay.Rejected{}, e)
    case Pay.Processing{}:
      e => not_a_payable_status(Pay.Processing{}, e)
    case Pay.Error{}:
      e => Inr{{==}}
    case Pay.Paid{}:
      e => not_a_payable_status(Pay.Paid{}, e)
    case Pay.ScheduledForPayment{}:
      e => not_a_payable_status(Pay.ScheduledForPayment{}, e)
    case Pay.Spam{}:
      e => not_a_payable_status(Pay.Spam{}, e)
    case Pay.Canceled{}:
      e => not_a_payable_status(Pay.Canceled{}, e)
    case Pay.InviteDeclined{}:
      e => not_a_payable_status(Pay.InviteDeclined{}, e)

def not_a_platform_expense(-expense_type: Pay.ExpenseType, e: {True{} == False{} : Bool}) -> {expense_type == Pay.Settlement{} : Pay.ExpenseType} | {expense_type == Pay.PlatformBilling{} : Pay.ExpenseType}:
  Empty.absurd({expense_type == Pay.Settlement{} : Pay.ExpenseType} | {expense_type == Pay.PlatformBilling{} : Pay.ExpenseType}, true_is_not_false(e))

def platform_expense_is_settlement_or_billing(expense_type: Pay.ExpenseType) -> {Bool.not(Pay.is_platform_expense(expense_type)) == False{} : Bool} -> {expense_type == Pay.Settlement{} : Pay.ExpenseType} | {expense_type == Pay.PlatformBilling{} : Pay.ExpenseType}:
  match expense_type:
    case Pay.Invoice{}:
      e => not_a_platform_expense(Pay.Invoice{}, e)
    case Pay.Receipt{}:
      e => not_a_platform_expense(Pay.Receipt{}, e)
    case Pay.FundingRequest{}:
      e => not_a_platform_expense(Pay.FundingRequest{}, e)
    case Pay.Grant{}:
      e => not_a_platform_expense(Pay.Grant{}, e)
    case Pay.Unclassified{}:
      e => not_a_platform_expense(Pay.Unclassified{}, e)
    case Pay.Charge{}:
      e => not_a_platform_expense(Pay.Charge{}, e)
    case Pay.Settlement{}:
      e => Inl{{==}}
    case Pay.PlatformBilling{}:
      e => Inr{{==}}

# A charge that was not entered by hand is a card charge.
def is_card_charge(-expense_type: Pay.ExpenseType, -manual: Bool, charge: {expense_type == Pay.Charge{} : Pay.ExpenseType}, by_card: {manual == False{} : Bool}) -> {Bool.and(Pay.is_charge(expense_type), Bool.not(manual)) == True{} : Bool}:
  %Equal.sym(Pay.ExpenseType, expense_type, Pay.Charge{}, charge) : {Bool.and(Pay.is_charge(_), Bool.not(manual)) == True{} : Bool}
  %Equal.sym(Bool, manual, False{}, by_card) : {Bool.not(_) == True{} : Bool}
  {==}

# Expense payments: the laws
# ==========================

def Laws.only_host_admins_can_mark_expenses_as_paid(e, h, allowed):
  check_host_needs_host_admin(Pay.type_of(e), h)(allowed_after_screening_passed_host(Pay.screen(e), Pay.type_of(e), h)(allowed))

def Laws.paying_requires_the_right_to_mark_as_paid(e, h, allowed):
  allowed_payment_was_marked(Pay.mark_as_paid(e, h), Pay.is_charge(Pay.type_of(e)))(allowed)

def Laws.only_host_admins_can_pay_expenses(e, h, allowed):
  Laws.only_host_admins_can_mark_expenses_as_paid(e, h, Laws.paying_requires_the_right_to_mark_as_paid(e, h, allowed))

def Laws.host_admins_can_pay_approved_invoices():
  {==}

def Laws.screening_is_final_when_marking_as_paid(e, h, reason, screened):
  %Equal.sym(Pay.Verdict, Pay.screen(e), Pay.Deny{reason}, screened) : {Pay.after_screening(_, Pay.type_of(e), h) == Pay.Deny{reason} : Pay.Verdict}
  {==}

def Laws.screening_is_final_when_paying(e, h, reason, screened):
  %Equal.sym(Pay.Verdict, Pay.screen(e), Pay.Deny{reason}, screened) : {Pay.reject_charges(Pay.after_screening(_, Pay.type_of(e), h), Pay.is_charge(Pay.type_of(e))) == Pay.Deny{reason} : Pay.Verdict}
  {==}

def passed_screening(+e: Pay.ExpenseFacts, h: Pay.HostFacts, allowed: {Pay.mark_as_paid(e, h) == Pay.Allow{} : Pay.Verdict}) -> {Pay.screen(e) == Pay.Allow{} : Pay.Verdict}:
  allowed_after_screening_passed_screening(Pay.screen(e), Pay.type_of(e), h)(allowed)

def passed_host(+e: Pay.ExpenseFacts, +h: Pay.HostFacts, allowed: {Pay.mark_as_paid(e, h) == Pay.Allow{} : Pay.Verdict}) -> {Pay.check_host(Pay.type_of(e), h) == Pay.Allow{} : Pay.Verdict}:
  allowed_after_screening_passed_host(Pay.screen(e), Pay.type_of(e), h)(allowed)

def Laws.only_approved_or_errored_expenses_are_paid(e, h, allowed):
  payable_status_is_approved_or_error(Pay.status_of(e))(screen_needs_payable_status(e)(passed_screening(e, h, allowed)))

def Laws.charges_are_never_paid(e, h, charge):
  allowed => contradiction(Pay.is_charge(Pay.type_of(e)), Equal.cong(Pay.ExpenseType, Bool, x => Pay.is_charge(x), Pay.type_of(e), Pay.Charge{}, charge), allowed_payment_is_not_a_charge(Pay.mark_as_paid(e, h), Pay.is_charge(Pay.type_of(e)))(allowed))

def Laws.card_charges_are_never_marked_as_paid(e, h, charge, by_card):
  allowed => contradiction(Bool.and(Pay.is_charge(Pay.type_of(e)), Bool.not(Pay.is_manually_created_charge(e))), is_card_charge(Pay.type_of(e), Pay.is_manually_created_charge(e), charge, by_card), screen_needs_no_card_charge(e)(passed_screening(e, h, allowed)))

def Laws.tokens_without_the_expenses_scope_cannot_pay(e, h, no_scope):
  match e:
    case Pay.ExpenseFacts{True{}, expense_type, manual, status, can_use}:
      Empty.absurd({Pay.mark_as_paid(Pay.ExpenseFacts{True{}, expense_type, manual, status, can_use}, h) == Pay.Deny{Pay.InvalidScope{}} : Pay.Verdict}, true_is_not_false(no_scope))
    case Pay.ExpenseFacts{False{}, expense_type, manual, status, can_use}:
      {==}

def Laws.guests_cannot_pay_expenses(e, h, guest):
  allowed => contradiction(Pay.is_authenticated(h), check_host_needs_authentication(Pay.type_of(e), h)(passed_host(e, h, allowed)), guest)

def Laws.limited_users_cannot_pay_expenses(e, h, limited):
  allowed => contradiction(Pay.can_use_expenses(e), screen_needs_usable_expenses(e)(passed_screening(e, h, allowed)), limited)

# With the host blocked, "blocked and not owed to the platform" being false
# leaves "not owed to the platform" false.
def blocked_host_pays_platform_only(-is_blocked: Bool, -not_platform: Bool, blocked: {is_blocked == True{} : Bool}, e: {Bool.and(is_blocked, not_platform) == False{} : Bool}) -> {not_platform == False{} : Bool}:
  %blocked : {Bool.and(_, not_platform) == False{} : Bool}
  e

def Laws.hosts_with_unpaid_bills_only_pay_the_platform(e, h, blocked, allowed):
  platform_expense_is_settlement_or_billing(Pay.type_of(e))(blocked_host_pays_platform_only(Pay.is_blocked_for_unpaid_billing(h), Bool.not(Pay.is_platform_expense(Pay.type_of(e))), blocked, check_host_needs_no_block(Pay.type_of(e), h)(passed_host(e, h, allowed))))

# GraphQL v1: the laws
# ====================

def gate_checks_need_no_personal_refusal(oauth_refused: Bool, personal_refused: Bool) -> {V1.gate_checks(oauth_refused, personal_refused) == V1.Accept{} : V1.Verdict} -> {personal_refused == False{} : Bool}:
  match oauth_refused personal_refused:
    case True{} _:
      e => Empty.absurd({personal_refused == False{} : Bool}, oauth_rejection_is_not_accept(e))
    case False{} True{}:
      e => Empty.absurd({True{} == False{} : Bool}, personal_rejection_is_not_accept(e))
    case False{} False{}:
      e => {==}

def Laws.oauth_tokens_need_an_allow_listed_application_on_v1(r, oauth, accepted):
  match r:
    case V1.Request{True{}, True{}, personal, token_allowed}:
      {==}
    case V1.Request{True{}, False{}, personal, token_allowed}:
      Empty.absurd({False{} == True{} : Bool}, oauth_rejection_is_not_accept(accepted))
    case V1.Request{False{}, app_allowed, personal, token_allowed}:
      Empty.absurd({app_allowed == True{} : Bool}, false_is_not_true(oauth))

def Laws.personal_tokens_need_to_be_allow_listed_on_v1(r, personal, accepted):
  match r:
    case V1.Request{oauth, app_allowed, True{}, True{}}:
      {==}
    case V1.Request{oauth, app_allowed, True{}, False{}}:
      Empty.absurd({False{} == True{} : Bool}, true_is_not_false(gate_checks_need_no_personal_refusal(Bool.and(oauth, Bool.not(app_allowed)), True{})(accepted)))
    case V1.Request{oauth, app_allowed, False{}, token_allowed}:
      Empty.absurd({token_allowed == True{} : Bool}, false_is_not_true(personal))

def Laws.requests_without_tokens_pass_the_v1_gate(r, no_oauth, no_personal):
  match r:
    case V1.Request{False{}, app_allowed, False{}, token_allowed}:
      {==}
    case V1.Request{False{}, app_allowed, True{}, token_allowed}:
      Empty.absurd({V1.gate(V1.Request{False{}, app_allowed, True{}, token_allowed}) == V1.Accept{} : V1.Verdict}, true_is_not_false(no_personal))
    case V1.Request{True{}, app_allowed, personal, token_allowed}:
      Empty.absurd({V1.gate(V1.Request{True{}, app_allowed, personal, token_allowed}) == V1.Accept{} : V1.Verdict}, true_is_not_false(no_oauth))

# Payouts: the two-factor rolling limit
# =====================================
#
# Amounts are natural numbers, built from 0n by adding one. A fact about every
# amount is proven for 0n, then for 1n+p given that it holds for p: the recursive
# call is that assumption. A fact about every sequence of payouts is proven the
# same way: for the empty sequence, then for one more payout in front.

def zero_is_within(limit: Nat) -> {Nat.is_le(0n, limit) == True{} : Bool}:
  match limit:
    case 0n:
      {==}
    case 1n+p:
      {==}

# Whether the new total fits or not, what is remembered is within the limit:
# the new total when it fits, and zero when it does not.
def count_or_ask_stays_within(limit: Nat, total: Nat, fits: Bool) -> {Nat.is_le(total, limit) == fits : Bool} -> {Nat.is_le(Limit.paid_since_token(Limit.count_or_ask(fits, total)), limit) == True{} : Bool}:
  match fits:
    case True{}:
      e => e
    case False{}:
      e => zero_is_within(limit)

# One payout: whatever was remembered before, what is remembered after is within the limit.
def decide_stays_within(+limit: Nat, +paid: +Maybe<Nat>, +amount: Nat) -> {Nat.is_le(Limit.paid_since_token(Limit.decide(limit, paid, amount)), limit) == True{} : Bool}:
  match paid:
    case None{}:
      zero_is_within(limit)
    case Some{total}:
      count_or_ask_stays_within(limit, Nat.add(total, amount), Nat.is_le(Nat.add(total, amount), limit))({==})

# Any number of payouts, by induction on the sequence. The first payout leaves
# the memory within the limit (above), and the rest of the sequence starts from there.
def Laws.no_sequence_of_payouts_exceeds_the_rolling_limit(amounts, limit, paid, starts_within):
  match amounts:
    case Nil{}:
      starts_within
    case Con{amount, rest}:
      Laws.no_sequence_of_payouts_exceeds_the_rolling_limit(rest, limit, Some{Limit.paid_since_token(Limit.decide(limit, paid, amount))}, decide_stays_within(limit, paid, amount))

def counted_in_full(fits: Bool, total: Nat) -> {Limit.asks_for_token(Limit.count_or_ask(fits, total)) == False{} : Bool} -> {Limit.paid_since_token(Limit.count_or_ask(fits, total)) == total : Nat}:
  match fits:
    case True{}:
      e => {==}
    case False{}:
      e => Empty.absurd({0n == total : Nat}, true_is_not_false(e))

def Laws.payouts_without_a_token_are_counted_in_full(limit, total, amount, no_token):
  counted_in_full(Nat.is_le(Nat.add(total, amount), limit), Nat.add(total, amount))(no_token)

def Laws.the_first_payout_always_needs_a_token(limit, amount):
  {==}

def Laws.payouts_within_the_limit_need_no_token(limit, total, amount, fits):
  %Equal.sym(Bool, Nat.is_le(Nat.add(total, amount), limit), True{}, fits) : {Limit.asks_for_token(Limit.count_or_ask(_, Nat.add(total, amount))) == False{} : Bool}
  {==}

# An amount above limit + 1 is above limit.
def above_the_next_is_above(amount: Nat, limit: Nat) -> {Nat.is_le(amount, 1n+limit) == False{} : Bool} -> {Nat.is_le(amount, limit) == False{} : Bool}:
  match amount limit:
    case 0n 0n:
      e => Empty.absurd({True{} == False{} : Bool}, true_is_not_false(e))
    case 0n 1n+l:
      e => Empty.absurd({True{} == False{} : Bool}, true_is_not_false(e))
    case 1n+a 0n:
      e => {==}
    case 1n+a 1n+l:
      above_the_next_is_above(a, l)

# Adding to an amount that is above the limit leaves it above the limit, by
# induction on what is added.
def sum_above_the_limit(total: Nat, +limit: Nat, +amount: Nat) -> {Nat.is_le(amount, limit) == False{} : Bool} -> {Nat.is_le(Nat.add(total, amount), limit) == False{} : Bool}:
  match total limit:
    case 0n 0n:
      e => e
    case 0n 1n+l:
      e => e
    case 1n+p 0n:
      e => {==}
    case 1n+p 1n+l:
      e => sum_above_the_limit(p, l, amount)(above_the_next_is_above(amount, l)(e))

def Laws.payouts_above_the_limit_always_need_a_token(limit, paid, amount, above):
  match paid:
    case None{}:
      {==}
    case Some{total}:
      %Equal.sym(Bool, Nat.is_le(Nat.add(total, amount), limit), False{}, sum_above_the_limit(total, limit, amount)(above)) : {Limit.asks_for_token(Limit.count_or_ask(_, Nat.add(total, amount))) == True{} : Bool}
      {==}

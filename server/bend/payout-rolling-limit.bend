# Payouts: the rolling limit above which a host admin must present a 2FA token.
#
# A host can require two-factor authentication for payouts. Asking for a token
# on every payout would be tedious, so one token opens a window: the admin may
# then pay without a token until the payouts add up to more than the host's
# rolling limit, at which point a new token is required and the count restarts.
#
# This file is the decision itself: `npm run bend:build` compiles it to
# generated/payout-rolling-limit.mjs, which `validateExpensePayout2FALimit`
# (server/graphql/common/expenses.ts) calls through ./payout-rolling-limit.ts.
# Laws: /LAWS.bend. Amounts are in cents of the host currency.
#
# Unlike the other files of this directory, the inputs here have no bound: any
# amount, any number of payouts. No test can try them all; the proofs do.

import Base

#   ask_for_token:    a fresh 2FA token is required for this payout
#   paid_since_token: what to remember, the total paid without a token since the last one
type Decision is Data:
  Decision{ask_for_token: Bool, paid_since_token: Nat}

def asks_for_token(d: Decision) -> Bool:
  match d:
    case Decision{ask, _}:
      ask

def paid_since_token(d: Decision) -> Nat:
  match d:
    case Decision{_, paid}:
      paid

# A payout that fits is counted; one that does not asks for a token, which
# restarts the count.
def count_or_ask(fits: Bool, total: Nat) -> Decision:
  match fits:
    case True{}:
      Decision{False{}, total}
    case False{}:
      Decision{True{}, 0n}

# `paid` is the total remembered from the previous payouts: None when nothing is
# remembered, which is the case for a first payout and once the memory expires.
def decide(limit: Nat, paid: +Maybe<Nat>, amount: Nat) -> Decision:
  match paid:
    case None{}:
      Decision{True{}, 0n}
    case Some{total}:
      +new_total = Nat.add(total, amount)
      count_or_ask(Nat.is_le(new_total, limit), new_total)

# Is what is remembered within the limit? Nothing remembered counts as within.
def is_within(limit: Nat, paid: +Maybe<Nat>) -> Bool:
  match paid:
    case None{}:
      True{}
    case Some{total}:
      Nat.is_le(total, limit)

# What is remembered after a whole sequence of payouts, each decided in turn.
# The API never calls this: it exists so that laws can speak about sequences.
def replay(amounts: +List<Nat>, +limit: Nat, paid: +Maybe<Nat>) -> +Maybe<Nat>:
  match amounts:
    case Nil{}:
      paid
    case Con{amount, rest}:
      replay(rest, limit, Some{paid_since_token(decide(limit, paid, amount))})

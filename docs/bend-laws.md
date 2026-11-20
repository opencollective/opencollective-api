# Laws (Bend)

Some rules of Open Collective must hold in every case, not only in the cases a test tries: _expense payments can
only be triggered by host admins_. We write these rules as **laws** in [Bend](https://bend-lang.com/), a language
whose type checker is a proof checker. A change that breaks a law does not pass CI.

This is an experiment. It covers three decisions so far: paying expenses, token access to GraphQL v1, and the
rolling limit above which a payout requires a fresh 2FA token.

## Layout

| File                          | What it is                                                      | Who writes it        |
| ----------------------------- | --------------------------------------------------------------- | -------------------- |
| `LAWS.bend`                   | The laws. Each one is a claim about the code in `server/bend/`. | Humans               |
| `PROOF.bend`                  | A proof of each law.                                            | AI agents            |
| `server/bend/*.bend`          | The decisions, as pure functions.                               | Humans and AI agents |
| `server/bend/generated/*.mjs` | The same decisions compiled to JavaScript. Never edit by hand.  | `npm run bend:build` |
| `server/bend/*.ts`            | Typed wrappers: they convert values and call the compiled code. | Humans and AI agents |

The Bend code is not a model of the TypeScript code. It is the code that runs: `canPayExpense` and
`canMarkAsPaid` (`server/graphql/common/expenses.ts`) load the facts, call the compiled decision, and turn a
denial into an error. The same goes for the `/graphql/v1` middleware in `server/routes.ts` and for
`validateExpensePayout2FALimit`.

## Commands

```bash
npm run bend:install
```

```bash
npm run bend:check
```

```bash
npm run bend:build
```

- `bend:install` installs the pinned Bend version into `~/.bend`, after verifying its checksum. Linux and macOS only.
- `bend:check` runs `bend PROOF.bend`. It prints `ALL PROOFS CHECK` when every law is proven, and
  `SOME PROOFS FAIL` with the first failing step otherwise.
- `bend:build` recompiles `server/bend/*.bend`. Commit the result: production does not have Bend installed.

CI runs the `Bend laws` job, which checks the laws and that `server/bend/generated/` is up to date. You do not
need Bend installed to work on the rest of the API.

## Changing a rule

1. Edit the decision in `server/bend/*.bend`.
2. Run `npm run bend:check`. If a proof fails, either the change breaks a law (then it is a bug: fix the code), or
   the proof needs to follow the code (then fix `PROOF.bend`). Do not weaken a law to get a green check: changing
   `LAWS.bend` changes what Open Collective promises, and deserves its own review.
3. Run `npm run bend:build` and commit the compiled files with the source.

`bend guide` prints the language guide. A law looks like this:

```python
# LAW: expense payments can only be triggered by host admins.
law only_host_admins_can_pay_expenses:
  for +e: Pay.ExpenseFacts
  for +h: Pay.HostFacts
  for allowed: {Pay.pay(e, h) == Pay.Allow{} : Pay.Verdict}
  {Pay.is_host_admin(h) == True{} : Bool}
```

Read it as: for every expense `e` and host situation `h`, if `pay` answers `Allow`, then the user is a host admin.

## How it works

A law is a type, and a proof is a program of that type. `{a == b : T}` is the type of the evidence that `a` and
`b` are the same value. The only way to build such evidence from nothing is `{==}`, which the checker accepts when
both sides compute to the same result. So checking a proof is type checking: `bend PROOF.bend` runs no test and
tries no input.

To prove a law for every input, the proof splits the inputs into cases with `match`. In each case the checker
replaces the variable with that case and computes: `pay(e, h)` with a host admin flag set to `False` computes to a
denial, whatever the other fields are. The checker refuses a `match` that misses a case.

Some inputs have no bound: an amount, a sequence of payouts. These are built in steps (a number is `0n` or `1n+p`, a
list is empty or an element in front of a list), so a proof handles the first step, then one more step given that
the law holds for the rest. That recursive call is induction, and Bend only accepts it on a smaller input, which is
what makes it cover every number and every list. The law that no sequence of payouts exceeds the rolling limit is
proven this way.

Proofs do not exist at run time. `bend:build` compiles only the functions of `server/bend/*.bend` to plain
JavaScript, where a `Nat` is a JavaScript number.

## What a green check means, and what it does not

A proof covers the Bend function, for all of its inputs. Three things sit outside of it:

- **The facts.** `is_host_admin` is a boolean that TypeScript computes. If `isHostAdmin()` is wrong, the law still
  holds and the payment is still wrong. The laws constrain the decision, not how its inputs are loaded.
- **The callers.** A mutation that pays an expense without calling `canPayExpense` is not bound by any law. So is a
  condition added in TypeScript around the call: keep the wrappers free of logic.
- **The compiler.** The proof is about the Bend source; Node runs the JavaScript that Bend compiles it to. The tests
  in `test/server/bend/` compare the compiled code against the previous TypeScript rules, for every combination of
  inputs where there are finitely many and on samples otherwise, and check that the wrappers reject values the
  compiled code would misread. Numbers are one such gap: a `Nat` has no upper bound in a proof, and the compiled code
  stops at 2^48-1, where it throws.

`bend PROOF.bend --verdict` rechecks the proofs with a small kernel that is itself proven in Lean. It needs Lean
4.34 installed and is not part of CI yet.

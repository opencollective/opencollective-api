# Laws (Bend)

Some rules of Open Collective must hold in every case, not only in the cases a test tries: _expense payments can
only be triggered by host admins_. We write these rules as **laws** in [Bend](https://bend-lang.com/), a language
whose type checker is a proof checker. A change that breaks a law does not pass CI.

This is an experiment. It covers two decisions so far: paying expenses, and token access to GraphQL v1.

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
denial into an error. The same goes for the `/graphql/v1` middleware in `server/routes.ts`.

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

## What a green check means, and what it does not

A proof covers the Bend function, for all of its inputs. Three things sit outside of it:

- **The facts.** `is_host_admin` is a boolean that TypeScript computes. If `isHostAdmin()` is wrong, the law still
  holds and the payment is still wrong. The laws constrain the decision, not how its inputs are loaded.
- **The callers.** A mutation that pays an expense without calling `canPayExpense` is not bound by any law. So is a
  condition added in TypeScript around the call: keep the wrappers free of logic.
- **The compiler.** The proof is about the Bend source; Node runs the JavaScript that Bend compiles it to. The tests
  in `test/server/bend/` compare the compiled code against the previous TypeScript rules for every combination of
  inputs, and check that the wrappers reject values the compiled code would misread.

`bend PROOF.bend --verdict` rechecks the proofs with a small kernel that is itself proven in Lean. It needs Lean
4.34 installed and is not part of CI yet.

# Private organizations (API)

This document describes the **technical** shape for private organizations.

## Product expectations (API-relevant)

- **Goal:** Some accounts (organizations, funds, collectives, hosts) should exist as **private**: usable from the dashboard and authorized integrations only, not discoverable or readable like public profiles.
- **Separation:** A **single fiscal host tree must not mix** public and private hosted accounts. If the host is private, hosted children are private too (see [Data model](#data-model)).
- **Immutability:** Visibility is **not** something users toggle after creation. There is no "make profile public/private" flow in scope; private accounts are created through **manual** operations (the `isPrivate` flag is **not** exposed on `createOrganization` and similar mutations in this phase).
- **Silos:** Private collective A must not imply visibility into private collective B unless normal roles already grant it (same as public accounts, but with stricter read paths).

## Data model

- **Column:** `Collectives.isPrivate` (boolean, default `false`), with history on `CollectiveHistories`. Migration: `migrations/20260423000000-add-is-private-to-collectives.ts`.
- **Inheritance on create:** `Collective.beforeCreate` sets `isPrivate` when the new account is hosted by a private host or parent (`server/models/Collective.ts`). New projects/events under a private parent inherit privacy. Out of safety, we duplicate this logic in `createCollective`/`createProject`/`createEvent`/`createVendor` mutations.
- **Consistency check:** `checks/model/hosted-collectives.ts` asserts that accounts hosted by a private fiscal host have `isPrivate = true`.

## Who can see a private account?

The `req.loaders.Collective.canSeePrivateAccount` DataLoader (`server/graphql/loaders/collective.ts`) is the central definition. For a private account, access is allowed when the remote user:

- is a **root** admin, or
- has **ADMIN** or **ACCOUNTANT** on the account, its **fiscal host**, or its **parent** (for projects/events), or
- is ADMIN/ACCOUNTANT on a **hosted collective** of a private **host organization** (so host admins can open the host dashboard).

Everyone else is treated as unauthorized for **direct** account reads.

Helpers in `server/lib/private-accounts.ts`:

- `assertCanSeeAccount` / `assertCanSeeAllAccounts` throw **`Forbidden`** with a message that the account is private, so the client can tell **"exists but denied"** from a generic not-found where that distinction is intentional.
- `canSeePrivateAccount` / `canSeeAllPrivateAccounts` are used when logic needs a boolean (for example, **order** visibility).

## GraphQL and REST behavior

- **GraphQL V2:** Account-scoped queries and collections call `assertCanSee*` or equivalent filters after loading collectives. Top-level account queries (`account`, `collective`, `host`, etc.) call `assertCanSeeAccount` in `server/graphql/v2/query/AccountQuery.ts`.
- **GraphQL V1:** The legacy `Collective` query and related surfaces use the same helpers where applicable (`server/graphql/v1/queries.js`).
- **REST / permalinks:** Short links (`/id/:id`) go through `server/lib/permalink/entity-handlers/handlers.ts` and `handlePermalink`, which check private visibility; unauthorized users are redirected (see `test/server/routes/privateAccounts.test.ts`).

## Business rules tied to privacy

- **Cross-host expenses:** Private payee accounts cannot submit expenses to collectives under a **different** fiscal host (`assertPrivateOrganizationNoCrossHostExpense` in `server/graphql/common/expenses.ts`). This keeps private trees from accidentally bridging hosts.
- **Add funds:** For a **private** host, `canAddFundsFromAccount` only allows source accounts that belong to that host's tree (and other narrow exceptions); trusted-host / allow-all-accounts style flags apply only when the host is **not** private (`server/graphql/common/orders.ts`).

### Features to hide or disable for private accounts

Several product areas assume a **public** profile. For private organizations they should not be available in the same form. The intended direction is to gate them at the **API** via account **feature status** (for example `UNSUPPORTED` where the feature flag system applies).

Features called out as **not relevant** for private accounts and candidates for `UNSUPPORTED` (or equivalent enforcement):

| Area                                  | Notes                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| **Updates**                           | Public-style updates and discovery do not apply.                                       |
| **Contribution flow**                 | No public donate / checkout to arbitrary visitors.                                     |
| **Tiers**                             | Public tier selection and marketing tied to tiers.                                     |
| **Goal**                              | Public funding goals on the profile.                                                   |
| **Profile page personalization**      | Public profile customization surfaces.                                                 |
| **Contribution policies**             | Policies aimed at public contributors.                                                 |
| **Conversations**                     | Community conversations tied to public visibility.                                     |
| **Manage host**                       | Moving a private tree between hosts is out of scope or restricted.                     |
| **Cross-host expenses**               | Already blocked in expense mutations (see above).                                      |
| **Cross-host added funds**            | Same host-tree constraint as add funds for private hosts (see above).                  |
| **Adding funds from public profiles** | Tightened when the host is private (`canAddFundsFromAccount`).                         |
| **Gift cards**                        | Public / cross-profile gift card flows are not appropriate without a dedicated design. |

**Adapted behavior (not only OFF):**

- **Team / members:** Private accounts should support **ADMIN** and **ACCOUNTANT** roles as the meaningful team roles; broader public-oriented roles may need to be disallowed or unused for private orgs.

Implementation is split across API feature flags and frontend checks; track status in [#8739](https://github.com/opencollective/opencollective/issues/8739).

## Surfaces at risk of leaking a private organization

Any read path that loads an account, a list keyed by account, or embedded account fields can leak names, slugs, balances, or relationship graphs. The implementation focuses on these categories:

| Surface                                                | Risk                                                        | How we address it (current direction)                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Account lookup** (slug, id, github)                  | Full profile exposure                                       | `assertCanSeeAccount` on V2 account queries; V1 parity where implemented.                                                                                                                                                                                                                                                                                                                          |
| **`memberOf` / memberships**                           | Lists show private collectives a user backed or administers | Default filter `isPrivate: false` on the joined collective; relaxed only for roles that may see those accounts (`server/graphql/v2/interface/IsMemberOf.js`, and similar patterns in V1 `types.js` / `CollectiveInterface.js`).                                                                                                                                                                    |
| **`members` / hosted lists**                           | Enumerating people or children under a private host         | Parent account resolution is gated; collection queries filter or assert as appropriate.                                                                                                                                                                                                                                                                                                            |
| **Transactions**                                       | Financial history                                           | `TransactionsCollectionQuery` loads `isPrivate` and uses `assertCanSeeAllAccounts` for relevant account scope.                                                                                                                                                                                                                                                                                     |
| **Orders / contributions**                             | Reveal private recipient or private contributor context     | **Single order:** `assertOrderAccessibleForPrivateCollective` allows host admins, people who can see the **collective**, or the **from** collective when the loader allows it (`server/graphql/common/orders.ts`, `server/graphql/v2/query/OrderQuery.ts`). **Collections** assert visibility on the queried account. Prevents orders from "advertising" a private destination to unrelated users. |
| **Expenses**                                           | Same as orders, plus draft invites                          | `assertExpenseAccessibleForPrivateCollective` after host/collective checks; draft access via `draftKey` remains a controlled exception (`server/graphql/common/expenses.ts`). Expense collections assert all referenced accounts where needed.                                                                                                                                                     |
| **Updates, conversations, activities, tags**           | Content tied to a private collective                        | Dedicated collection queries combine privacy asserts with existing rules (`UpdatesCollectionQuery`, `ActivitiesCollectionQuery`, etc.).                                                                                                                                                                                                                                                            |
| **Tiers, applications, PayPal plans, export requests** | Indirect account exposure                                   | Entry resolvers call `assertCanSeeAccount` or `assertCanSeeAllAccounts`.                                                                                                                                                                                                                                                                                                                           |
| **Search**                                             | Index or SQL search returns private slugs                   | SQL account search adds `c."isPrivate" IS NOT TRUE` in `server/lib/sql-search.ts` (with a TODO for fuller behavior in [opencollective#8734](https://github.com/opencollective/opencollective/issues/8734)). The beta **OpenSearch** `Query.search` path is tracked as **`skipped`** in the schema audit until #8734 is done (`test/stories/graphql-private-orgs-privacy.test.ts`).                 |
| **Files, attachments, invoices**                       | Binary or URL leakage                                       | Handled through existing expense/order permission evaluators **after** the private-collective gate passes; any **new** download route should reuse the same visibility helpers.                                                                                                                                                                                                                    |

If you add a new query or field that returns `Account` (or a concrete account type), assume it is **high risk** until it is gated or explicitly classified.

## Testing and guardrails

Per [#8731](https://github.com/opencollective/opencollective/issues/8731):

- **Story tests:** `test/stories/private-organization.test.ts` covers end-to-end visibility scenarios; `test/stories/graphql-private-orgs-privacy.test.ts` **introspects the V2 schema** and enforces an allow-list of privacy strategies (`entry-gate`, `parent-gate`, `no-private`, `admin-only`, `skipped`) for every field that can expose an account. Adding a new account-returning field without updating that map should fail CI.
- **ESLint:** `eslint-rules/require-private-account-check.js` (rule `private-accounts/require-account-visibility-check`) requires top-level GraphQL query resolvers that load a `Collective` to call one of the helpers from `server/lib/private-accounts.ts`.
- **Unit tests:** `test/server/lib/private-accounts.test.ts`, route tests under `test/server/routes/privateAccounts.test.ts`, and V1/V2 GraphQL tests (for example comments in `test/server/graphql/v1/collective.test.js`).

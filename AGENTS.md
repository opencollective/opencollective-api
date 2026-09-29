# opencollective-api

Primary GraphQL API: business logic, persistence, and integrations.

## Stack

Node/Express/TS+Babel, Apollo (V2 `/graphql`, V1 `/graphql/v1`), Sequelize+Kysely, Postgres, Redis sessions, Passport/JWT/WebAuthn. Stripe/PayPal/Wise/Manual. Nodemailer+Handlebars, S3/MinIO. OpenSearch (alpha; prod still Postgres FTS). Helmet/GraphQL Armor, Sentry/Hyperwatch. Mocha/Sinon/Chai. Cron: Heroku scheduler on `cron/`.

Private organizations: `docs/private-organizations.md`.

## Rules

- **DB:** To understand the schema, read the models, not the migrations. Sequelize for simple queries; Kysely for complex joins. Do not migrate existing queries to Kysely unless asked.
- **TS:** New files (including migrations and tests) in TypeScript. Do not convert JS to TS unless asked.
- **V1 auth:** OAuth and personal tokens are rejected unless allow-listed (`application.data.enableGraphqlV1` on the app, `data.allowGraphQLV1` on the token). See `server/routes.ts`.
- **Money:** Amounts are stored ×100 for every currency, including zero-decimal (JPY, KRW). ¥15 → `1500`. List: `ZERO_DECIMAL_CURRENCIES` in `server/constants/currencies.ts`.
- **PayPal recurring** (`Subscription.isManagedExternally` + `paypalSubscriptionId`): `Orders.totalAmount` must match the PayPal billing plan (`PaypalPlans`). PayPal is the source of truth. `updateOrder` requires a new `paypalSubscriptionId` after PayPal approval when changing amount or tier. Audit: `scripts/paypal/check-subscriptions-amounts.ts` (default last 7 days; `PAYPAL_SUBSCRIPTION_AMOUNT_CHECK_LOOKBACK_DAYS` or `--lookback-days`).

**New or changed V2 resolvers** - check all four (mirror nearby resolvers; OWASP GraphQL + Authorization):

1. **Permissions** - host (`req.remoteUser.isAdminOfCollective(host)`), collective admin/accountant, contributor, root (`isRoot()`), or public/guest. Throw `Unauthorized` / `Forbidden` from `server/graphql/errors`.
2. **Private accounts** - `assertCanSeeAccount` / `assertCanSeeAllAccounts` (throw `Forbidden`) or `canSeePrivateAccount` / `canSeeAllPrivateAccounts` from `server/lib/private-accounts.ts`. Top-level account queries are gated in `AccountQuery.ts`; collection filters and nested resolvers are easy to miss.
3. **2FA** - `twoFactorAuthLib` from `server/lib/two-factor-authentication`: `enforceForAccount`, `enforceForAccountsUserIsAdminOf`, `validateRequest`. Clients send `x-two-factor-authentication`; reuse `TWO_FACTOR_SESSIONS_PARAMS` for short sessions.
4. **OAuth scopes** - mutations must call a helper from `server/graphql/common/scope-check.ts` (ESLint `graphql-mutations/require-scope-check`). Prefer domain helpers (`checkRemoteUserCanUseExpenses`, …) or `enforceScope` / `checkScope` (`server/constants/oauth-scopes.ts`). Session-only: `rejectOAuthAndPersonalTokenAuth(req)`. Public/guest mutations: ESLint opt-out plus a comment explaining why.

**Not defects:** public GraphQL introspection, permissive API CORS.

## Quality

From this repo: `npm run type:check`, `npm run lint:check`, `npm run prettier:check` (fix: `prettier:write`). Tests: Mocha (`npm run test`). Schema dumps: `npm run graphql:update`.

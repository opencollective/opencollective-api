# Developing with Emails

## Receiving Emails

- Start mailpit server with: `npm run mailpit`
- Open `http://localhost:1080` to browse outgoing emails

## Email Templates

Email templates can be viewed locally by running `npm run compile:email <template name>` and making sure there is data for that template in `scripts/compile-email.js`.

### Onboarding emails

- activated.collective.as.host.hbs
  - Audience: Admins of accounts that became Fiscal Hosts (Users or Organizations).
  - Trigger: When an account calls activateMoneyManagement (formerly becomeHost) and we emit ACTIVATED_MONEY_MANAGEMENT (formerly ACTIVATED_COLLECTIVE_AS_HOST).
  - Content:
    - Pricing and platform fees; link to `opencollective.com/pricing`
    - Host Dashboard docs, setup guidance, FAQ, setting host fees
    - Discord invite and help pages

- activated.collective.as.independent.hbs
  - Audience: Admins of Collectives that set up as Independent.
  - Trigger: When a Collective calls becomeHost and we emit ACTIVATED_COLLECTIVE_AS_INDEPENDENT.
  - Content:
    - Independent Collective setup (receipts, connect Stripe/bank)
    - Receiving money (bank transfers, add funds)
    - Expenses and payouts docs
    - Discord and documentation

- collective.approved.hbs
  - Audience: Admins of Collectives whose host application was approved.
  - Trigger: Activity COLLECTIVE_APPROVED (auto-switches to host-specific variants for OSC/SCN).
  - Content:
    - “Get Started” CTA to the Collective page
    - Help pages and Discord

- collective.approved.opensource.hbs
  - Audience: Admins of Collectives approved by Open Source Collective (OSC).
  - Trigger: COLLECTIVE_APPROVED with host slug `opensource` (template is auto-selected).
  - Content:
    - OSC onboarding video
    - Tips to get first contributors
    - Links: crowdfunding “Ten Steps”, OSC docs, platform docs, GitHub Sponsors, OSC updates
    - Contact `hello@oscollective.org`, Discord; OSC signature

- collective.approved.the-social-change-nest.hbs
  - Audience: Admins of Collectives approved by The Social Change Nest (SCN).
  - Trigger: COLLECTIVE_APPROVED with host slug `the-social-change-nest` (template is auto-selected).
  - Content:
    - Approval confirmation and notifications overview
    - Admin change contact email
    - Customizing page docs

- collective.created.hbs
  - Audience: Admins of newly created Collectives (non-OSC/SCN).
  - Trigger: COLLECTIVE_CREATED; suppressed for OSC/SCN (they get their host-specific approval emails instead).
  - Content:
    - Share your page link
    - Customize settings (logo, cover, tiers, team)
    - Integrations (widgets, GitHub Sponsors, embeds, integrations)
    - Engage (Updates, moderation tools)
    - Receive/spend money (guides, submit an expense)
    - Discord and docs

- github.signup.hbs
  - Audience: Collectives created via GitHub signup (historical).
  - Trigger: Not currently sent (kept for legacy; no active sender in code).
  - Content:
    - Same onboarding steps as creation (customize, integrate, engage, receive/spend)
    - Inspiration section (Discover, blog)
    - Discord and docs

- onboarding.day2.hbs
  - Audience: Admins of active Collectives created 2 days ago (excluding OSC-hosted).
  - Trigger: Daily cron `20-onboarding.js` via processOnBoardingTemplate('onboarding.day2', XDaysAgo(2)).
  - Content:
    - Advice to get first financial contributors now
    - Links: blog how‑tos/case studies, Discover, docs quick start
    - “Get Started” CTA, Discord

- onboarding.day2.opensource.hbs
  - Audience: Admins of Collectives approved by OSC 2 days ago.
  - Trigger: Daily cron via processHostOnBoardingTemplate('onboarding.day2.opensource', Host=OSC, approvedAt=XDaysAgo(2)).
  - Content:
    - Community tools: Updates, integrations, widgets, Events, Connected Collectives
    - Finance tools: Budget, Expenses, Customize tiers
    - Contact OSC; OSC signature

- onboarding.day2.organization.hbs
  - Audience: Admins/creators of Organizations created 2 days ago.
  - Trigger: Daily cron maps ‘onboarding.day2’ to the organization-specific template.
  - Content:
    - Feedback request to improve sponsor experience
    - Help pages and Discord

- onboarding.day3.hbs
  - Audience: Admins of active Collectives created 3 days ago (excluding OSC-hosted).
  - Trigger: Daily cron processOnBoardingTemplate('onboarding.day3', XDaysAgo(3)).
  - Content:
    - Invite your team (roles/permissions)
    - Send Updates
    - Automate interactions (Discord/Slack, etc.)
    - Website widgets/embeds
    - Help pages

- onboarding.day35.inactive.hbs
  - Audience: Admins of Collectives with no transactions 35 days after creation.
  - Trigger: Daily cron processOnBoardingTemplate('onboarding.day35.inactive', XDaysAgo(35), onlyCollectivesWithoutTransactions).
  - Content:
    - Offer help; links to Collective stories/case studies
    - Help pages and Discord

- onboarding.day7.hbs
  - Audience: Admins of active Collectives created 7 days ago (excluding OSC-hosted).
  - Trigger: Daily cron processOnBoardingTemplate('onboarding.day7', XDaysAgo(7)).
  - Content:
    - Edit contribution tiers (CTA to tiers settings)
    - Data exports & reporting
    - Expenses
    - Events

- onboarding.noExpenses.hbs
  - Audience: Admins of Collectives with no expenses after 14 days.
  - Trigger: Daily cron processOnBoardingTemplate('onboarding.noExpenses', XDaysAgo(14), onlyCollectivesWithoutExpenses).
  - Content:
    - Encourage submitting or inviting an expense
    - Key info: admin approval then host payout; paid once funds available; save payout details
    - CTA to submit an expense

- onboarding.noExpenses.opensource.hbs
  - Audience: Intended for OSC-hosted Collectives with no expenses.
  - Trigger: Not used by `20-onboarding.js` (no active sender found).
  - Content:
    - Same as noExpenses, plus: “OSC pays out twice a week”
    - Blog link with spending ideas
    - CTA to submit an expense

- onboarding.noUpdates.hbs
  - Audience: Admins of Collectives with no published Updates after 21 days.
  - Trigger: Daily cron processOnBoardingTemplate('onboarding.noUpdates', XDaysAgo(21), onlyCollectivesWithoutUpdates).
  - Content:
    - Why Updates matter and link to Updates/communication docs
    - CTA to post an Update (dashboard link)

- organization.collective.created.hbs
  - Audience: The user who created the Organization (primary admin).
  - Trigger: Activity ORGANIZATION_COLLECTIVE_CREATED on org creation.
  - Content:
    - “Contribute as” guidance for org vs self
    - Submit expenses as an Organization
    - Gift cards; bulk contributions and Funds
    - Team contribution limits; manage recurring contributions
    - Invoices/receipts (transactions page)
    - Org-specific docs; Discord

# Stripe

## Platform account

By default, a platform account is configured (`config.stripe.secret`). We use the test environment of Open Collective Inc.

By convention, the Organization with slug "opencollective" is using the Platform account configuration.

### Webhooks

Start the Stripe tool in your terminal:

```
stripe login
```

Pick the Open Collective Inc. account. Then:

```
stripe listen --forward-to localhost:3060/webhooks/stripe
```

Add the "webhook signing secret" to your environment:

```
STRIPE_WEBHOOK_SIGNING_SECRET=whsec_XXX
```

## Host accounts

### For Credit Card payments

The Host Stripe account simply needs to be connected to the Platform using the web interface.

The Platform will be triggering everything from its account using "Stripe Connect".

### For Virtual Cards

At the moment, it's not possible to interact with Virtual Cards from the Platform account, we need to get the Host secret key for this.

Checklist for Fiscal Hosts (test mode):

1. Ask Stripe to [activate Issuing](https://dashboard.stripe.com/setup/issuing/activate) on your Fiscal Host account
2. [Top Up](https://dashboard.stripe.com/test/topups) the Issuing balance with a reasonable amount (e.g.: $1000).
3. Create a generic Card Holder and make sure it's the only one (Organization, name it like the Fiscal Host)
4. Create a new dedicated [Restricted Secret Key](https://dashboard.stripe.com/test/apikeys), select write for all Issuing features (Name: Restricted Issuing)
5. Add the Secret Key to the Fiscal Host (`pnpm script ./scripts/update-connected-account-stripe-token`)

### Webhooks

Start the Stripe tool in your terminal:

```
stripe login
```

- To test Credit Card payments. Pick the Platform (Open Collective Inc.) account.
- To test Virtual Cards. Pick the Fiscal Host (e.g.: Open Source Collective) account.

Then:

```
stripe listen --forward-to localhost:3060/webhooks/stripe
```

Add the "webhook signing secret" to your environment:

_If switching between Platform and Fiscal Host, you'll have to change the "webhook signing secret" back and forth._

```
STRIPE_WEBHOOK_SIGNING_SECRET=whsec_XXX
```

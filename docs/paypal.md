# PayPal

## Developing / testing sandbox

### Buyer account

This is the account you'll use to make the (fake) payment. Go to [https://developer.paypal.com/developer/accounts/create](https://developer.paypal.com/developer/accounts/create), login with your personnal PayPal account then create a test account.

### Merchant account

1. Create an app here: [https://developer.paypal.com/developer/applications/create](https://developer.paypal.com/developer/applications/create)
2. Use the generated merchant credentials to set the following variables in API's `.env`:

```
PAYPAL_ENVIRONMENT=sandbox
PAYPAL_APP_ID=
```

3\. Encrypt your client secret, from the API repository:

```bash
npm run script scripts/encrypt.js PAYPAL_CLIENT_SECRET
```

4\. Manually create a ConnectedAccount with your `clientId` and your encrypted `clientSecret`:

```sql
INSERT INTO "ConnectedAccounts" ("service", "clientId", "token", "CollectiveId", "createdAt", "updatedAt")
VALUES (E'paypal', clientId, clientSecret, hostCollectiveId, NOW(), NOW());
```

5\. Create buyer's credentials on [https://developer.paypal.com/developer/accounts/create](https://developer.paypal.com/developer/accounts/create)

And you're ready to go. Use the credentials generated in step 2. to authenticate when ordering.

## Webhooks

Configuring webhooks is a requirement if you need to be notified of events such as payments, refunds, disputes, etc. This is especially the case for the PayPal Subscription feature.

### Setting up Webhooks

In production, Webhooks are setup automatically when the PayPal integration is connected. In development, they need to be setup manually.

To do so, you'll need a service to bridge the gap between the internet and your local machine. We recommend using [ngrok](https://ngrok.com/). After installing ngrok, run the following command in your terminal:

```bash
ngrok http 3060
```

### Configuring the Webhook on PayPal

1. Go to your PayPal Developer Dashboard: [https://developer.paypal.com/developer/applications/](https://developer.paypal.com/developer/applications/)
2. Click on the app you created for the PayPal integration
3. Click on the `Webhooks` tab
4. Click on `Add Webhook`
5. Select "All events" for the event types
6. Enter the URL of your local webhook endpoint (see ngrok output) and append `/webhooks/paypal` to it

## Known issues

- The button may require multiple clicks to trigger on dev or staging. It should not affect production (see [https://github.com/paypal/paypal-checkout/issues/471](https://github.com/paypal/paypal-checkout/issues/471))

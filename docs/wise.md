# Wise

Wise application keys are already set up by default and can be used in sandbox.
All you need to do is to create a test business account on https://sandbox.transferwise.tech/ and connect it to any local fiscal host.

**Attention:**

- On development, transferwise.ott setting is always enabled.
  - This means we're always going through the batched expenses flow.
  - The Wise OTT code is always 111-111

## Setting up Webhooks

You can setup a fully functional webhook using NGrok to forward to your local API and running.

To run Ngrok, open a new window and run:

```sh
$ ngrok http 3060
```

To set up the Wise webhook, run:

```sh
$ API_URL="https://cd6e-2-138-96-138.ngrok.io" pnpm script scripts/setup-transferwise-webhook.js up

> script
> babel-node --extensions .js,.ts $1 scripts/setup-transferwise-webhook.js up

info: Connecting to postgres://127.0.0.1/opencollective_dvl
info: Fixer API is not configured, lib/currency will always return 1.1
Creating TransferWise app webhook...
info: Creating TransferWise App Webhook on https://cd6e-2-138-96-138.ngrok.io/webhooks/transferwise...
Webhook created: b0acf39d-73ed-4ad2-a3c6-25f11ac785d5 -> https://cd6e-2-138-96-138.ngrok.io/webhooks/transferwise
Done.

```

Make sure you delete the webhook later on with:

```sh
$ pnpm script scripts/setup-transferwise-webhook.js down "b0acf39d-73ed-4ad2-a3c6-25f11ac785d5"

> script
> babel-node --extensions .js,.ts $1 scripts/setup-transferwise-webhook.js down b0acf39d-73ed-4ad2-a3c6-25f11ac785d5

info: Connecting to postgres://127.0.0.1/opencollective_dvl
info: Fixer API is not configured, lib/currency will always return 1.1
Deleting webhook  b0acf39d-73ed-4ad2-a3c6-25f11ac785d5
Done.
```

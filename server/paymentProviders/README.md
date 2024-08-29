# Payment Providers

## Implementing a new Payment Provider

In `server/paymentProviders/{providerName}`, create a new class that extends one of the derived classes of `BasePaymentProviderService` (check `server/paymentProviders/types.ts`).

If implementing a payment provider with recurring managed externally, make sure to update the freeze account feature (in `components/dashboard/sections/collectives/FreezeAccountModal.tsx` and `server/graphql/v2/mutation/AccountMutations.ts`) to properly update the wording and support the pause/resume functionality.

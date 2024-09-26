import { expect } from 'chai';
import moment from 'moment';
import { createSandbox } from 'sinon';
import Stripe from 'stripe';

import { PAYMENT_METHOD_SERVICE } from '../../server/constants/paymentMethods';
import PlatformConstants, { __setIsTestingMigration } from '../../server/constants/platform';
import { TransactionKind } from '../../server/constants/transaction-kind';
import { TransactionTypes } from '../../server/constants/transactions';
import stripe from '../../server/lib/stripe';
import { ConnectedAccount } from '../../server/models';
import * as PaypalAPI from '../../server/paymentProviders/paypal/api';
import * as StripeCommon from '../../server/paymentProviders/stripe/common';
import { fakeActiveHost, fakeCollective, fakeOrganization, fakeUser, randStr } from '../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../utils';

describe('platform constants', () => {
  let sandbox;
  beforeEach(() => {
    __setIsTestingMigration(true);
    sandbox = createSandbox();
  });
  afterEach(() => {
    sandbox.restore();
    __setIsTestingMigration(false);
  });

  it('platform collective id is same before migration cutoff', () => {
    sandbox.useFakeTimers(moment('2024-10-01T00:00:00Z').toDate());
    expect(PlatformConstants.PlatformCollectiveId).to.equal(8686);
  });

  it('platform collective id is migrated after migration cutoff', () => {
    sandbox.useFakeTimers(moment('2024-10-01T00:00:01Z').toDate());
    expect(PlatformConstants.PlatformCollectiveId).to.equal(835523);
  });
});

describe('platform transactions', () => {
  let sandbox;
  beforeEach(async () => {
    __setIsTestingMigration(true);
    sandbox = createSandbox();
    stubStripePayments(sandbox);
    stubPaypalPayments(sandbox);
    await resetTestDB();

    await fakeOrganization({
      id: 8686,
      slug: randStr('platform-'),
    });

    await fakeOrganization({
      id: 835523,
      slug: randStr('platform-'),
    });
  });

  afterEach(() => {
    sandbox.restore();
    __setIsTestingMigration(false);
  });

  const StripeOrderData = {
    frequency: 'ONETIME',
    paymentMethod: {
      service: 'STRIPE',
      type: 'CREDITCARD',
      name: '4242',
      creditCardInfo: {
        token: 'tok_testtoken123456789012345',
        brand: 'VISA',
        country: 'US',
        expMonth: 11,
        expYear: 2024,
      },
    },
    amount: {
      valueInCents: 5000,
    },
    platformTipAmount: {
      valueInCents: 2500,
    },
  };

  const PaypalOrderData = {
    ...StripeOrderData,
    paymentMethod: {
      service: 'PAYPAL',
      type: 'PAYMENT',
      paypalInfo: {
        orderId: randStr('paypal-order-id-'),
      },
    },
  };

  [
    {
      title: 'Platform tips uses current platform collective id before migration',
      when: moment('2024-10-01T00:00:00Z').toDate(),
      orderData: StripeOrderData,
      expect(result: Awaited<ReturnType<typeof makeContribution>>) {
        const platformTipTransaction = result.data?.createOrder?.order?.transactions?.find(
          txn => txn.type === TransactionTypes.CREDIT && txn.kind === TransactionKind.PLATFORM_TIP,
        );
        expect(platformTipTransaction).to.exist;
        expect(platformTipTransaction.toAccount.legacyId).to.eql(8686);
      },
    },
    {
      title: 'Platform tip uses current platform collective id after migration',
      when: moment('2024-10-01T00:00:01Z').toDate(),
      orderData: StripeOrderData,
      expect(result: Awaited<ReturnType<typeof makeContribution>>) {
        const platformTipTransaction = result.data?.createOrder?.order?.transactions?.find(
          txn => txn.type === TransactionTypes.CREDIT && txn.kind === TransactionKind.PLATFORM_TIP,
        );
        expect(platformTipTransaction).to.exist;
        expect(platformTipTransaction.toAccount.legacyId).to.eql(835523);
      },
    },
    {
      title: 'Platform tip debt uses current platform collective id before migration',
      when: moment('2024-10-01T00:00:00Z').toDate(),
      orderData: PaypalOrderData,
      expect(result: Awaited<ReturnType<typeof makeContribution>>) {
        const platformTipTransaction = result.data?.createOrder?.order?.transactions?.find(
          txn => txn.type === TransactionTypes.CREDIT && txn.kind === TransactionKind.PLATFORM_TIP,
        );
        expect(platformTipTransaction).to.exist;
        expect(platformTipTransaction.toAccount.legacyId).to.eql(8686);

        const platformTipDebtTransaction = result.data?.createOrder?.order?.transactions?.find(
          txn => txn.type === TransactionTypes.CREDIT && txn.kind === TransactionKind.PLATFORM_TIP_DEBT,
        );
        expect(platformTipDebtTransaction).to.exist;
        expect(platformTipDebtTransaction.fromAccount.legacyId).to.eql(8686);
      },
    },
    {
      title: 'Platform tip debt uses current platform collective id after migration',
      when: moment('2024-10-01T00:00:01Z').toDate(),
      orderData: PaypalOrderData,
      expect(result: Awaited<ReturnType<typeof makeContribution>>) {
        const platformTipTransaction = result.data?.createOrder?.order?.transactions?.find(
          txn => txn.type === TransactionTypes.CREDIT && txn.kind === TransactionKind.PLATFORM_TIP,
        );
        expect(platformTipTransaction).to.exist;
        expect(platformTipTransaction.toAccount.legacyId).to.eql(835523);

        const platformTipDebtTransaction = result.data?.createOrder?.order?.transactions?.find(
          txn => txn.type === TransactionTypes.CREDIT && txn.kind === TransactionKind.PLATFORM_TIP_DEBT,
        );
        expect(platformTipDebtTransaction).to.exist;
        expect(platformTipDebtTransaction.fromAccount.legacyId).to.eql(835523);
      },
    },
    {
      title: 'Platform share uses current platform collective id before migration',
      when: moment('2024-10-01T00:00:00Z').toDate(),
      hostParams: {
        hostFeePercent: 20,
        data: {
          hostFeeSharePercent: 10,
          plan: {
            platformTips: true,
          },
        },
      } satisfies Parameters<typeof makeContribution>[0],
      orderData: StripeOrderData,
      expect(result: Awaited<ReturnType<typeof makeContribution>>) {
        const hostFeeShareTransaction = result.data?.createOrder?.order?.transactions?.find(
          txn => txn.type === TransactionTypes.CREDIT && txn.kind === TransactionKind.HOST_FEE_SHARE,
        );
        expect(hostFeeShareTransaction).to.exist;
        expect(hostFeeShareTransaction.toAccount.legacyId).to.eql(8686);
      },
    },
    {
      title: 'Platform share uses current platform collective id after migration',
      when: moment('2024-10-01T00:00:01Z').toDate(),
      hostParams: {
        hostFeePercent: 20,
        data: {
          hostFeeSharePercent: 10,
          plan: {
            platformTips: true,
          },
        },
      } satisfies Parameters<typeof makeContribution>[0],
      orderData: StripeOrderData,
      expect(result: Awaited<ReturnType<typeof makeContribution>>) {
        const hostFeeShareTransaction = result.data?.createOrder?.order?.transactions?.find(
          txn => txn.type === TransactionTypes.CREDIT && txn.kind === TransactionKind.HOST_FEE_SHARE,
        );
        expect(hostFeeShareTransaction).to.exist;
        expect(hostFeeShareTransaction.toAccount.legacyId).to.eql(835523);
      },
    },
    {
      title: 'Platform share debt uses current platform collective id before migration',
      when: moment('2024-10-01T00:00:00Z').toDate(),
      hostParams: {
        hostFeePercent: 20,
        data: {
          hostFeeSharePercent: 10,
          plan: {
            platformTips: true,
          },
        },
      } satisfies Parameters<typeof makeContribution>[0],
      orderData: PaypalOrderData,
      expect(result: Awaited<ReturnType<typeof makeContribution>>) {
        const hostFeeShareTransaction = result.data?.createOrder?.order?.transactions?.find(
          txn => txn.type === TransactionTypes.CREDIT && txn.kind === TransactionKind.HOST_FEE_SHARE,
        );
        expect(hostFeeShareTransaction).to.exist;
        expect(hostFeeShareTransaction.toAccount.legacyId).to.eql(8686);

        const hostFeeShareDebtTransaction = result.data?.createOrder?.order?.transactions?.find(
          txn => txn.type === TransactionTypes.CREDIT && txn.kind === TransactionKind.HOST_FEE_SHARE_DEBT,
        );
        expect(hostFeeShareDebtTransaction).to.exist;
        expect(hostFeeShareDebtTransaction.fromAccount.legacyId).to.eql(8686);
      },
    },
    {
      title: 'Platform share debt uses current platform collective id after migration',
      when: moment('2024-10-01T00:00:01Z').toDate(),
      hostParams: {
        hostFeePercent: 20,
        data: {
          hostFeeSharePercent: 10,
          plan: {
            platformTips: true,
          },
        },
      } satisfies Parameters<typeof makeContribution>[0],
      orderData: PaypalOrderData,
      expect(result: Awaited<ReturnType<typeof makeContribution>>) {
        const hostFeeShareTransaction = result.data?.createOrder?.order?.transactions?.find(
          txn => txn.type === TransactionTypes.CREDIT && txn.kind === TransactionKind.HOST_FEE_SHARE,
        );
        expect(hostFeeShareTransaction).to.exist;
        expect(hostFeeShareTransaction.toAccount.legacyId).to.eql(835523);

        const hostFeeShareDebtTransaction = result.data?.createOrder?.order?.transactions?.find(
          txn => txn.type === TransactionTypes.CREDIT && txn.kind === TransactionKind.HOST_FEE_SHARE_DEBT,
        );
        expect(hostFeeShareDebtTransaction).to.exist;
        expect(hostFeeShareDebtTransaction.fromAccount.legacyId).to.eql(835523);
      },
    },
  ].map(tc =>
    ('only' in tc && tc.only ? it.only : it)(tc.title, async () => {
      sandbox.useFakeTimers(tc.when);

      const result = await makeContribution(
        {
          data: {
            plan: {
              platformTips: true,
            },
          },
          ...tc.hostParams,
        },
        tc.orderData,
      );

      await tc.expect(result);
    }),
  );
});

function stubStripePayments(sandbox) {
  sandbox.stub(stripe.tokens, 'retrieve').callsFake(() =>
    Promise.resolve({
      card: {
        token: 'tok_testtoken123456789012345',
        brand: 'VISA',
        country: 'US',
        expMonth: 11,
        expYear: 2024,
        last4: '4242',
        name: 'John Smith',
      },
    } as any),
  );

  const stripePaymentMethodId = randStr('pm_');
  sandbox.stub(StripeCommon, 'resolvePaymentMethodForOrder').resolves({
    id: stripePaymentMethodId,
    customer: 'cus_test',
  });
  sandbox
    .stub(stripe.paymentIntents, 'create')
    .resolves({ id: 'pi_test', status: 'requires_confirmation' } as Stripe.Response<Stripe.PaymentIntent>);
  sandbox.stub(stripe.paymentIntents, 'confirm').resolves({
    id: stripePaymentMethodId,
    status: 'succeeded',
    charges: {
      // eslint-disable-next-line camelcase
      data: [{ id: 'ch_id', balance_transaction: 'txn_id' }],
    },
  } as any);

  sandbox.stub(stripe.balanceTransactions, 'retrieve').resolves({
    amount: 1100,
    currency: 'usd',
    fee: 0,
    // eslint-disable-next-line camelcase
    fee_details: [],
  } as any);
}

function stubPaypalPayments(sandbox) {
  sandbox.stub(PaypalAPI, 'paypalRequestV2').callsFake(async urlPath => {
    if (urlPath.endsWith('/authorize')) {
      return {
        // eslint-disable-next-line camelcase
        purchase_units: [
          {
            payments: {
              authorizations: [{ id: randStr('paypal-authorization-id-') }],
            },
          },
        ],
      };
    } else if (urlPath.endsWith('/capture')) {
      return {
        id: randStr('paypal-capture-id-'),
        status: 'COMPLETED',
      };
    } else if (urlPath.startsWith('payments/captures/')) {
      const captureId = urlPath.substring('payments/captures/'.length);
      return {
        id: captureId,
        status: 'COMPLETED',
        // eslint-disable-next-line camelcase
        amount: { value: 75.0, currency_code: 'USD' },
        // eslint-disable-next-line camelcase
        seller_receivable_breakdown: { paypal_fee: { value: '0.00' } },
      };
    } else if (urlPath.startsWith('checkout/orders/')) {
      return {
        // eslint-disable-next-line camelcase
        purchase_units: [
          {
            amount: {
              value: 75.0,
              // eslint-disable-next-line camelcase
              currency_code: 'USD',
            },
          },
        ],
      };
    }
  });
}

async function makeContribution(
  hostParams: Parameters<typeof fakeActiveHost>[0],
  orderData: object,
): Promise<{
  errors?: any[];
  data?: {
    createOrder: {
      order: {
        transactions: {
          type: TransactionTypes;
          kind: TransactionKind;
          toAccount: {
            legacyId: number;
          };
          fromAccount: {
            legacyId: number;
          };
        }[];
      };
    };
  };
}> {
  const host = await fakeActiveHost(hostParams);
  await ConnectedAccount.create({
    service: PAYMENT_METHOD_SERVICE.STRIPE,
    token: 'abc',
    CollectiveId: host.id,
  });

  const collective = await fakeCollective({
    HostCollectiveId: host.id,
  });

  const user = await fakeUser();

  return await graphqlQueryV2(
    `
        mutation CreateOrder($order: OrderCreateInput!) {
            createOrder(order: $order) {
                order {
                    legacyId
                    platformTipAmount {
                    valueInCents
                    }
                    platformTipEligible
                    transactions {
                    type
                    kind
                    amount {
                        valueInCents
                    }
                    toAccount {
                        legacyId
                    }
                    fromAccount {
                        legacyId
                    }
                    }
                }
            }
        }
      `,
    {
      order: {
        ...orderData,
        fromAccount: { legacyId: user.CollectiveId },
        toAccount: { legacyId: collective.id },
      },
    },
    user,
  );
}

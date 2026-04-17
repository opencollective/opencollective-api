/* eslint-disable camelcase */
import { expect } from 'chai';
import { cloneDeep } from 'lodash';
import sinon from 'sinon';
import type Stripe from 'stripe';
import { v4 as uuid } from 'uuid';

import {
  computeCorrectAnchorValues,
  computeGroupChanges,
  correctPlatformTipForCurrency,
  main,
} from '../../../../scripts/stripe/order-total-amount-issue/1-fix-invalid-amounts';
import { TransactionKind } from '../../../../server/constants/transaction-kind';
import models from '../../../../server/models';
import Transaction from '../../../../server/models/Transaction';
import StripeMocks from '../../../mocks/stripe';
import { fakeCollective, fakeHost, fakeTransaction, fakeUser } from '../../../test-helpers/fake-data';
import { resetTestDB, seedDefaultVendors } from '../../../utils';

// -- Helpers to build mock transaction-like objects ---

function mockTransaction(overrides: Record<string, unknown> = {}): Transaction {
  return {
    id: 1,
    kind: 'CONTRIBUTION',
    type: 'CREDIT',
    amount: 15000,
    currency: 'JPY',
    amountInHostCurrency: 15000,
    hostCurrency: 'JPY',
    hostCurrencyFxRate: 0.9971014492753624,
    netAmountInCollectiveCurrency: 15045,
    hostFeeInHostCurrency: 0,
    paymentProcessorFeeInHostCurrency: 0,
    platformFeeInHostCurrency: 0,
    taxAmount: 0,
    TransactionGroup: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    createdAt: new Date('2025-07-01'),
    data: {},
    ...overrides,
  } as unknown as Transaction;
}

function mockStripeCharge(params: {
  id: string;
  currency: string;
  amount: number;
  amount_captured: number;
  payment_intent: string | null;
  balance_transaction?: string | Stripe.BalanceTransaction | null;
}): Stripe.Charge {
  const balance_transaction = params.balance_transaction ?? params.id.replace(/^ch_/, 'txn_');
  return {
    ...cloneDeep(StripeMocks.charges.succeeded),
    id: params.id,
    amount: params.amount,
    amount_captured: params.amount_captured,
    currency: params.currency,
    payment_intent: params.payment_intent,
    balance_transaction,
    // object: 'charge',
    // amount_refunded: 0,
    // application: null,
    // application_fee: null,
    // application_fee_amount: null,
    // billing_details: {
    //   address: null,
    //   email: null,
    //   name: null,
    //   phone: null,
    // },
    // calculated_statement_descriptor: null,
    // captured: true,
    // created: 1_713_312_000,
    // customer: null,
    // description: null,
    // disputed: false,
    // failure_balance_transaction: null,
    // failure_code: null,
    // failure_message: null,
    // fraud_details: null,
    // invoice: null,
    // livemode: false,
    // metadata: {},
    // on_behalf_of: null,
    // outcome: null,
    // paid: true,
    // payment_method: null,
    // payment_method_details: null,
    // receipt_email: null,
    // receipt_number: null,
    // receipt_url: null,
    // refunded: false,
    // review: null,
    // shipping: null,
    // source: null,
    // source_transfer: null,
    // statement_descriptor: null,
    // statement_descriptor_suffix: null,
    // status: 'succeeded',
    // transfer_data: null,
    // transfer_group: null,
  };
}

function mockStripeBalanceTransaction(params: {
  id: string;
  amount: number;
  currency: string;
  fee: number;
  net: number;
  source?: string | Stripe.BalanceTransactionSource | null;
}): Stripe.BalanceTransaction {
  return {
    id: params.id,
    object: 'balance_transaction',
    amount: params.amount,
    available_on: 1_713_398_400,
    created: 1_713_312_000,
    currency: params.currency,
    description: null,
    exchange_rate: null,
    fee: params.fee,
    fee_details: [],
    net: params.net,
    reporting_category: 'charge',
    source: params.source ?? null,
    status: 'available',
    type: 'charge',
  };
}

function makeJpyChargeData({
  amountCaptured = 172,
  omitAmountCaptured = false,
  applicationFeeAmount,
  platformTip = 2250,
  // Default to 2200 for backwards compatibility. Pass null to exclude the field from data.
  platformTipInHostCurrency = 2200 as number | null,
  btAmount = 172,
}: {
  amountCaptured?: number;
  omitAmountCaptured?: boolean;
  applicationFeeAmount?: number;
  platformTip?: number;
  platformTipInHostCurrency?: number | null;
  btAmount?: number;
} = {}): Transaction['data'] {
  const charge = mockStripeCharge({
    id: 'ch_test_jpy',
    currency: 'jpy',
    amount: amountCaptured,
    amount_captured: omitAmountCaptured ? undefined : amountCaptured,
    payment_intent: 'pi_test_jpy',
    balance_transaction: 'txn_test_jpy',
  });
  if (applicationFeeAmount !== undefined) {
    (charge as unknown as Record<string, unknown>).application_fee_amount = applicationFeeAmount;
  }
  return {
    charge,
    balanceTransaction: mockStripeBalanceTransaction({
      id: 'txn_test_jpy',
      amount: btAmount,
      currency: 'jpy',
      fee: 28,
      net: btAmount - 28,
    }),
    platformTip,
    // Pass null to exclude platformTipInHostCurrency from the data object entirely.
    ...(platformTipInHostCurrency !== null ? { platformTipInHostCurrency } : {}),
    hasPlatformTip: true,
    isSharedRevenue: false,
    hostFeeSharePercent: 0,
    platformTipEligible: true,
    isPlatformRevenueDirectlyCollected: true,
  };
}

function makeUsdChargeData({
  amountCaptured = 100,
  platformTip = 0,
  btAmount = 100,
}: {
  amountCaptured?: number;
  platformTip?: number;
  btAmount?: number;
} = {}) {
  return {
    charge: mockStripeCharge({
      id: 'ch_test_usd',
      currency: 'usd',
      amount: amountCaptured,
      amount_captured: amountCaptured,
      payment_intent: 'pi_test_usd',
      balance_transaction: 'txn_test_usd',
    }),
    balanceTransaction: mockStripeBalanceTransaction({
      id: 'txn_test_usd',
      amount: btAmount,
      currency: 'usd',
      fee: 39,
      net: btAmount - 39,
    }),
    platformTip,
    hasPlatformTip: platformTip > 0,
    isSharedRevenue: true,
    hostFeeSharePercent: 50,
    platformTipEligible: false,
  };
}

function makeEurChargeData({
  amountCaptured = 575,
  applicationFeeAmount = 77,
  platformTip = 75,
  platformTipInHostCurrency = 75 as number | null,
  btAmount = 575,
}: {
  amountCaptured?: number;
  applicationFeeAmount?: number;
  platformTip?: number;
  platformTipInHostCurrency?: number | null;
  btAmount?: number;
} = {}): Transaction['data'] {
  const charge = mockStripeCharge({
    id: 'ch_test_eur',
    currency: 'eur',
    amount: amountCaptured,
    amount_captured: amountCaptured,
    payment_intent: 'pi_test_eur',
    balance_transaction: 'txn_test_eur',
  });
  (charge as unknown as Record<string, unknown>).application_fee_amount = applicationFeeAmount;
  return {
    charge,
    balanceTransaction: mockStripeBalanceTransaction({
      id: 'txn_test_eur',
      amount: btAmount,
      currency: 'eur',
      fee: 112,
      net: btAmount - 112,
    }),
    platformTip,
    ...(platformTipInHostCurrency !== null ? { platformTipInHostCurrency } : {}),
    hasPlatformTip: true,
    isSharedRevenue: false,
    hostFeeSharePercent: 0,
    platformTipEligible: true,
    isPlatformRevenueDirectlyCollected: true,
  };
}

// -- Unit tests for pure computation functions --

describe('scripts/stripe/fix-invalid-amounts', () => {
  describe('correctPlatformTipForCurrency', () => {
    it('returns 0 for falsy values', () => {
      expect(correctPlatformTipForCurrency(0, 'JPY')).to.equal(0);
      expect(correctPlatformTipForCurrency(0, 'USD')).to.equal(0);
    });

    it('rounds JPY platform tip through Stripe conversion (floor then *100)', () => {
      // 2250 in DB = ¥22.50 conceptually. Stripe floors to ¥22 -> DB 2200
      expect(correctPlatformTipForCurrency(2250, 'JPY')).to.equal(2200);
    });

    it('rounds down larger JPY fractional amounts', () => {
      // 2299 -> floor(2299/100)=22 -> 22*100=2200
      expect(correctPlatformTipForCurrency(2299, 'JPY')).to.equal(2200);
    });

    it('keeps already-rounded JPY amounts unchanged', () => {
      expect(correctPlatformTipForCurrency(2200, 'JPY')).to.equal(2200);
      expect(correctPlatformTipForCurrency(10000, 'JPY')).to.equal(10000);
    });

    it('does not modify non-zero-decimal currencies', () => {
      expect(correctPlatformTipForCurrency(2250, 'USD')).to.equal(2250);
      expect(correctPlatformTipForCurrency(100, 'EUR')).to.equal(100);
      expect(correctPlatformTipForCurrency(1, 'GBP')).to.equal(1);
    });

    it('handles other zero-decimal currencies (KRW)', () => {
      expect(correctPlatformTipForCurrency(1550, 'KRW')).to.equal(1500);
    });
  });

  describe('computeCorrectAnchorValues', () => {
    it('computes correct values for JPY with unrounded platform tip', () => {
      const anchor = mockTransaction({
        amount: 15000,
        currency: 'JPY',
        amountInHostCurrency: 15000,
        hostCurrency: 'JPY',
        hostCurrencyFxRate: 0.9971014492753624,
        netAmountInCollectiveCurrency: 15045,
        hostFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        taxAmount: 0,
        data: makeJpyChargeData(),
      });

      const result = computeCorrectAnchorValues(anchor);
      expect(result).to.not.be.null;
      // charge.amount_captured=172, convertFromStripeAmount('JPY',172) = 17200
      // correctPlatformTip = 2200 (from platformTipInHostCurrency, since JPY/JPY)
      // correctAmount = 17200 - 2200 = 15000
      expect(result.correctAmount).to.equal(15000);
      expect(result.correctAmountInHostCurrency).to.equal(15000);
      expect(result.correctHostCurrencyFxRate).to.equal(1);
      expect(result.correctNetAmountInCollectiveCurrency).to.equal(15000);
      expect(result.correctPlatformTip).to.equal(2200);
      expect(result.platformTipChanged).to.be.true;
    });

    it('computes correct values for USD async lag (amount mismatch)', () => {
      const anchor = mockTransaction({
        amount: 300,
        currency: 'USD',
        amountInHostCurrency: 100,
        hostCurrency: 'USD',
        hostCurrencyFxRate: 0.3333333333333333,
        netAmountInCollectiveCurrency: 300,
        hostFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        taxAmount: 0,
        data: makeUsdChargeData({ amountCaptured: 100, platformTip: 0 }),
      });

      const result = computeCorrectAnchorValues(anchor);
      expect(result).to.not.be.null;
      // charge.amount_captured=100, convertFromStripeAmount('USD',100) = 100
      // No platform tip
      // correctAmount = 100
      expect(result.correctAmount).to.equal(100);
      expect(result.correctAmountInHostCurrency).to.equal(100);
      expect(result.correctHostCurrencyFxRate).to.equal(1);
      expect(result.correctNetAmountInCollectiveCurrency).to.equal(100);
      expect(result.correctPlatformTip).to.equal(0);
      expect(result.platformTipChanged).to.be.false;
    });

    it('detects and corrects stale platformTipInHostCurrency (second-pass scenario)', () => {
      // Simulates a transaction that was already partially fixed: platformTip was corrected
      // from 3750 to 3700 and hostCurrencyFxRate from 0.9982... to 1.0, but
      // data.platformTipInHostCurrency was left stale at 3743 (= round(3750 * 0.9982...)).
      // This causes amountInHostCurrency = 28700 - 3743 = 24957 instead of 25000.
      const anchor = mockTransaction({
        amount: 25000,
        currency: 'JPY',
        amountInHostCurrency: 24957,
        hostCurrency: 'JPY',
        hostCurrencyFxRate: 1,
        netAmountInCollectiveCurrency: 23957,
        hostFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: -1000,
        platformFeeInHostCurrency: 0,
        taxAmount: 0,
        data: makeJpyChargeData({
          amountCaptured: 287,
          platformTip: 3700,
          platformTipInHostCurrency: 3743, // stale
          btAmount: 287,
        }),
      });

      const result = computeCorrectAnchorValues(anchor);
      expect(result).to.not.be.null;
      // correctPlatformTip = 3700 (already correct, no rounding needed)
      // correctPlatformTipInHostCurrency = round(3700 * 1.0) = 3700 (stale 3743 not trusted)
      // correctAmountInHostCurrency = 28700 - 3700 = 25000 (was 24957)
      // correctNetAmountInCollectiveCurrency = (25000 - 1000) / 1 = 24000 (was 23957)
      expect(result.correctAmount).to.equal(25000);
      expect(result.correctAmountInHostCurrency).to.equal(25000);
      expect(result.correctHostCurrencyFxRate).to.equal(1);
      expect(result.correctNetAmountInCollectiveCurrency).to.equal(24000);
      expect(result.correctPlatformTip).to.equal(3700);
      expect(result.correctPlatformTipInHostCurrency).to.equal(3700);
      expect(result.platformTipChanged).to.be.false;
      expect(result.platformTipInHostCurrencyChanged).to.be.true;
    });

    it('falls back to charge.amount when amount_captured is absent (older Stripe API responses)', () => {
      // Older charges (pre-2020) lack amount_captured; charge.amount equals the captured amount.
      const anchor = mockTransaction({
        amount: 10000,
        currency: 'JPY',
        amountInHostCurrency: 10000,
        hostCurrency: 'JPY',
        hostCurrencyFxRate: 1,
        netAmountInCollectiveCurrency: 10000,
        hostFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        taxAmount: 0,
        data: makeJpyChargeData({
          amountCaptured: 10000,
          omitAmountCaptured: true, // simulate missing amount_captured
          platformTip: 0,
          platformTipInHostCurrency: null,
          btAmount: 10000,
        }),
      });

      const result = computeCorrectAnchorValues(anchor);
      expect(result).to.not.be.null;
      // charge.amount=10000 used as fallback; convertFromStripeAmount('JPY', 10000) = 1000000
      expect(result.correctAmount).to.equal(1000000);
      expect(result.correctAmountInHostCurrency).to.equal(1000000);
      expect(result.correctHostCurrencyFxRate).to.equal(1);
    });

    it('corrects platformTip stored in Stripe units (EasyUploader case)', () => {
      // platformTip=300 (Stripe JPY units = ¥300) was stored as 300 OC instead of 30000 OC.
      // Detected because platformTip (OC) == application_fee_amount (Stripe) numerically.
      const anchor = mockTransaction({
        amount: 229700,
        currency: 'JPY',
        amountInHostCurrency: 229700,
        hostCurrency: 'JPY',
        hostCurrencyFxRate: 1,
        netAmountInCollectiveCurrency: 229700,
        hostFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        taxAmount: 0,
        data: makeJpyChargeData({
          amountCaptured: 2300,
          applicationFeeAmount: 300,
          platformTip: 300,
          platformTipInHostCurrency: null,
          btAmount: 2300,
        }),
      });

      const result = computeCorrectAnchorValues(anchor);
      expect(result).to.not.be.null;
      // correctPlatformTip = convertFromStripeAmount('JPY', 300) = 30000
      // correctAmount = 230000 - 30000 = 200000
      expect(result.correctPlatformTip).to.equal(30000);
      expect(result.correctAmount).to.equal(200000);
      expect(result.correctAmountInHostCurrency).to.equal(200000);
      expect(result.correctHostCurrencyFxRate).to.equal(1);
      expect(result.correctNetAmountInCollectiveCurrency).to.equal(200000);
      expect(result.platformTipChanged).to.be.true;
      expect(result.platformTipInHostCurrencyChanged).to.be.false; // no stored value to update
    });

    it('returns null when charge data is missing', () => {
      const anchor = mockTransaction({ data: {} });
      expect(computeCorrectAnchorValues(anchor)).to.be.null;
    });

    it('returns null when balanceTransaction is missing', () => {
      const anchor = mockTransaction({
        data: { charge: { amount_captured: 100, currency: 'usd' } },
      });
      expect(computeCorrectAnchorValues(anchor)).to.be.null;
    });

    it('preserves already-correct transactions (no-op)', () => {
      const anchor = mockTransaction({
        amount: 100,
        currency: 'USD',
        amountInHostCurrency: 100,
        hostCurrency: 'USD',
        hostCurrencyFxRate: 1,
        netAmountInCollectiveCurrency: 100,
        hostFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        taxAmount: 0,
        data: makeUsdChargeData({ amountCaptured: 100, platformTip: 0 }),
      });

      const result = computeCorrectAnchorValues(anchor);
      expect(result).to.not.be.null;
      expect(result.correctAmount).to.equal(100);
      expect(result.correctAmountInHostCurrency).to.equal(100);
      expect(result.correctHostCurrencyFxRate).to.equal(1);
    });

    it('handles fees on the anchor transaction', () => {
      const anchor = mockTransaction({
        amount: 300,
        currency: 'USD',
        amountInHostCurrency: 100,
        hostCurrency: 'USD',
        hostCurrencyFxRate: 0.3333333333333333,
        netAmountInCollectiveCurrency: 261,
        hostFeeInHostCurrency: -5,
        paymentProcessorFeeInHostCurrency: -34,
        platformFeeInHostCurrency: 0,
        taxAmount: 0,
        data: makeUsdChargeData({ amountCaptured: 100 }),
      });

      const result = computeCorrectAnchorValues(anchor);
      // correctAmountInHostCurrency = 100, fees = -39, fxRate = 1
      // net = (100 + (-5) + (-34) + 0) / 1 + 0 = 61
      expect(result.correctNetAmountInCollectiveCurrency).to.equal(61);
    });

    it('handles refund transactions where balanceTransaction.amount is negative', () => {
      // For Stripe refunds, balanceTransaction.amount is negative (outflow from Stripe's
      // perspective), but the OC refund CREDIT CONTRIBUTION records positive amounts
      // (the contributor is receiving money back). The FX rate must stay positive.
      const anchor = mockTransaction({
        amount: 15000,
        currency: 'JPY',
        amountInHostCurrency: 15000,
        hostCurrency: 'JPY',
        hostCurrencyFxRate: 0.9971014492753624,
        netAmountInCollectiveCurrency: 15044,
        hostFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        taxAmount: 0,
        data: makeJpyChargeData({ amountCaptured: 172, btAmount: -172 }),
      });

      const result = computeCorrectAnchorValues(anchor);
      expect(result).to.not.be.null;
      // charge.amount_captured=172 → correctTotalInOrderCurrency=17200
      // |balanceTransaction.amount|=172 → correctTotalInHostCurrency=17200
      // FX rate should be +1, not -1
      expect(result.correctHostCurrencyFxRate).to.equal(1);
      expect(result.correctAmount).to.equal(15000);
      expect(result.correctAmountInHostCurrency).to.equal(15000);
      expect(result.correctNetAmountInCollectiveCurrency).to.equal(15000);
      expect(result.correctPlatformTip).to.equal(2200);
      expect(result.platformTipChanged).to.be.true;
    });
  });

  describe('computeGroupChanges', () => {
    it('returns null when no anchor transaction exists', () => {
      const transactions = [mockTransaction({ kind: 'HOST_FEE', type: 'CREDIT' })];
      expect(computeGroupChanges(transactions)).to.be.null;
    });

    it('returns null when anchor has no charge data', () => {
      const transactions = [mockTransaction({ data: {} })];
      expect(computeGroupChanges(transactions)).to.be.null;
    });

    it('returns null when values are already correct', () => {
      const transactions = [
        mockTransaction({
          amount: 15000,
          currency: 'JPY',
          amountInHostCurrency: 15000,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: 15000,
          data: {
            ...makeJpyChargeData({ platformTip: 2200, platformTipInHostCurrency: 2200 }),
          },
        }),
      ];
      expect(computeGroupChanges(transactions)).to.be.null;
    });

    it('detects and fixes stale platformTipInHostCurrency (second-pass scenario)', () => {
      // After a first fix run: platformTip corrected (3750→3700), hostCurrencyFxRate (0.9982→1),
      // but platformTipInHostCurrency left stale at 3743, causing amountInHostCurrency = 24957
      // (should be 25000) and netAmountInCollectiveCurrency = 23957 (should be 24000).
      const tg = 'test-group-stale-tip-hc';
      const transactions = [
        mockTransaction({
          id: 50,
          TransactionGroup: tg,
          kind: 'CONTRIBUTION',
          type: 'CREDIT',
          amount: 25000,
          currency: 'JPY',
          amountInHostCurrency: 24957,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: 23957,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: -1000,
          platformFeeInHostCurrency: 0,
          taxAmount: 0,
          data: makeJpyChargeData({
            amountCaptured: 287,
            platformTip: 3700,
            platformTipInHostCurrency: 3743, // stale
            btAmount: 287,
          }),
        }),
        mockTransaction({
          id: 51,
          TransactionGroup: tg,
          kind: 'CONTRIBUTION',
          type: 'DEBIT',
          amount: -23957,
          currency: 'JPY',
          amountInHostCurrency: -23957,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: -25000,
          HostCollectiveId: null,
        }),
      ];

      const result = computeGroupChanges(transactions);
      expect(result).to.not.be.null;

      const anchorUpdate = result.updates.find(u => u.id === 50);
      expect(anchorUpdate).to.exist;
      expect(anchorUpdate.changes.amountInHostCurrency.before).to.equal(24957);
      expect(anchorUpdate.changes.amountInHostCurrency.after).to.equal(25000);
      expect(anchorUpdate.changes.netAmountInCollectiveCurrency.before).to.equal(23957);
      expect(anchorUpdate.changes.netAmountInCollectiveCurrency.after).to.equal(24000);
      expect(anchorUpdate.changes['data.platformTipInHostCurrency'].before).to.equal(3743);
      expect(anchorUpdate.changes['data.platformTipInHostCurrency'].after).to.equal(3700);
      expect(anchorUpdate.changes).to.not.have.property('data.platformTip');

      const debitUpdate = result.updates.find(u => u.id === 51);
      expect(debitUpdate).to.exist;
      expect(debitUpdate.changes.amount.before).to.equal(-23957);
      expect(debitUpdate.changes.amount.after).to.equal(-24000);
    });

    it('updates PLATFORM_TIP legs when only data.platformTipInHostCurrency is stale (EUR)', () => {
      // Same pattern as Code Rouge / EUR: platformTip=75 but platformTipInHostCurrency=77 (Stripe
      // application_fee_amount). CONTRIBUTION amount500 vs amountInHostCurrency 498; tip legs
      // keep amount=75 but amountInHostCurrency wrongly matches the stale77.
      const tg = 'test-group-eur-stale-tip-hc';
      const eurData = makeEurChargeData({
        platformTip: 75,
        platformTipInHostCurrency: 77,
      });
      const transactions = [
        mockTransaction({
          id: 80,
          TransactionGroup: tg,
          kind: 'CONTRIBUTION',
          type: 'CREDIT',
          amount: 500,
          currency: 'EUR',
          amountInHostCurrency: 498,
          hostCurrency: 'EUR',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: 498,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          taxAmount: 0,
          data: eurData,
        }),
        mockTransaction({
          id: 81,
          TransactionGroup: tg,
          kind: 'CONTRIBUTION',
          type: 'DEBIT',
          amount: -498,
          currency: 'EUR',
          amountInHostCurrency: -498,
          hostCurrency: 'EUR',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: -500,
          HostCollectiveId: null,
        }),
        mockTransaction({
          id: 82,
          TransactionGroup: tg,
          kind: 'PLATFORM_TIP',
          type: 'CREDIT',
          amount: 75,
          currency: 'EUR',
          amountInHostCurrency: 77,
          hostCurrency: 'EUR',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: 75,
        }),
        mockTransaction({
          id: 83,
          TransactionGroup: tg,
          kind: 'PLATFORM_TIP',
          type: 'DEBIT',
          amount: -75,
          currency: 'EUR',
          amountInHostCurrency: -77,
          hostCurrency: 'EUR',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: -75,
        }),
      ];

      const result = computeGroupChanges(transactions);
      expect(result).to.not.be.null;

      const ptCredit = result.updates.find(u => u.id === 82);
      expect(ptCredit).to.exist;
      expect(ptCredit.changes.amountInHostCurrency.before).to.equal(77);
      expect(ptCredit.changes.amountInHostCurrency.after).to.equal(75);

      const ptDebit = result.updates.find(u => u.id === 83);
      expect(ptDebit).to.exist;
      expect(ptDebit.changes.amountInHostCurrency.before).to.equal(-77);
      expect(ptDebit.changes.amountInHostCurrency.after).to.equal(-75);
    });

    it('fixes platformTip stored in Stripe units and updates PLATFORM_TIP transactions', () => {
      // Simulates the post-first-fix state for EasyUploader: amount was incorrectly set to 229700
      // (using wrong platformTip=300 OC instead of 30000 OC). The new run detects the bug via
      // platformTip == application_fee_amount and re-fixes everything.
      const tg = 'test-group-stripe-units-tip';
      const chargeData = makeJpyChargeData({
        amountCaptured: 2300,
        applicationFeeAmount: 300,
        platformTip: 300,
        platformTipInHostCurrency: null,
        btAmount: 2300,
      });
      const transactions = [
        mockTransaction({
          id: 60,
          TransactionGroup: tg,
          kind: 'CONTRIBUTION',
          type: 'CREDIT',
          amount: 229700,
          currency: 'JPY',
          amountInHostCurrency: 229700,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: 229700,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          taxAmount: 0,
          data: chargeData,
        }),
        mockTransaction({
          id: 61,
          TransactionGroup: tg,
          kind: 'CONTRIBUTION',
          type: 'DEBIT',
          amount: -229700,
          currency: 'JPY',
          amountInHostCurrency: -229700,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: -229700,
          HostCollectiveId: null,
        }),
        mockTransaction({
          id: 62,
          TransactionGroup: tg,
          kind: 'PLATFORM_TIP',
          type: 'CREDIT',
          amount: 300,
          currency: 'JPY',
          amountInHostCurrency: 300,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: 300,
        }),
        mockTransaction({
          id: 63,
          TransactionGroup: tg,
          kind: 'PLATFORM_TIP',
          type: 'DEBIT',
          amount: -300,
          currency: 'JPY',
          amountInHostCurrency: -300,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: -300,
        }),
      ];

      const result = computeGroupChanges(transactions);
      expect(result).to.not.be.null;

      const anchorUpdate = result.updates.find(u => u.id === 60);
      expect(anchorUpdate).to.exist;
      expect(anchorUpdate.changes.amount.before).to.equal(229700);
      expect(anchorUpdate.changes.amount.after).to.equal(200000);
      expect(anchorUpdate.changes['data.platformTip'].before).to.equal(300);
      expect(anchorUpdate.changes['data.platformTip'].after).to.equal(30000);

      const debitUpdate = result.updates.find(u => u.id === 61);
      expect(debitUpdate).to.exist;
      expect(debitUpdate.changes.amount.after).to.equal(-200000);

      const ptCreditUpdate = result.updates.find(u => u.id === 62);
      expect(ptCreditUpdate).to.exist;
      expect(ptCreditUpdate.changes.amount.before).to.equal(300);
      expect(ptCreditUpdate.changes.amount.after).to.equal(30000);

      const ptDebitUpdate = result.updates.find(u => u.id === 63);
      expect(ptDebitUpdate).to.exist;
      expect(ptDebitUpdate.changes.amount.before).to.equal(-300);
      expect(ptDebitUpdate.changes.amount.after).to.equal(-30000);
    });

    it('computes changes for JPY with unrounded platform tip', () => {
      const tg = 'test-group-jpy';
      const transactions = [
        // CREDIT CONTRIBUTION
        mockTransaction({
          id: 1,
          TransactionGroup: tg,
          kind: 'CONTRIBUTION',
          type: 'CREDIT',
          amount: 15000,
          currency: 'JPY',
          amountInHostCurrency: 15000,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 0.9971014492753624,
          netAmountInCollectiveCurrency: 15045,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          taxAmount: 0,
          data: makeJpyChargeData(),
        }),
        // DEBIT CONTRIBUTION
        mockTransaction({
          id: 2,
          TransactionGroup: tg,
          kind: 'CONTRIBUTION',
          type: 'DEBIT',
          amount: -15045,
          currency: 'JPY',
          amountInHostCurrency: -15045,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 0.9971014492753624,
          netAmountInCollectiveCurrency: -15000,
          HostCollectiveId: null,
        }),
        // CREDIT PLATFORM_TIP
        mockTransaction({
          id: 3,
          TransactionGroup: tg,
          kind: 'PLATFORM_TIP',
          type: 'CREDIT',
          amount: 2250,
          currency: 'JPY',
          amountInHostCurrency: 1500,
          hostCurrency: 'USD',
          hostCurrencyFxRate: 0.6667,
          netAmountInCollectiveCurrency: 2250,
        }),
        // DEBIT PLATFORM_TIP
        mockTransaction({
          id: 4,
          TransactionGroup: tg,
          kind: 'PLATFORM_TIP',
          type: 'DEBIT',
          amount: -2250,
          currency: 'JPY',
          amountInHostCurrency: -1500,
          hostCurrency: 'USD',
          hostCurrencyFxRate: 0.6667,
          netAmountInCollectiveCurrency: -2250,
        }),
      ];

      const result = computeGroupChanges(transactions);
      expect(result).to.not.be.null;
      expect(result.transactionGroup).to.equal(tg);
      expect(result.updates).to.have.length(4);

      // CREDIT CONTRIBUTION updates
      const anchorUpdate = result.updates.find(u => u.id === 1);
      expect(anchorUpdate).to.exist;
      expect(anchorUpdate.changes).to.have.property('hostCurrencyFxRate');
      expect(anchorUpdate.changes.hostCurrencyFxRate.before).to.equal(0.9971014492753624);
      expect(anchorUpdate.changes.hostCurrencyFxRate.after).to.equal(1);
      expect(anchorUpdate.changes).to.have.property('netAmountInCollectiveCurrency');
      expect(anchorUpdate.changes.netAmountInCollectiveCurrency.before).to.equal(15045);
      expect(anchorUpdate.changes.netAmountInCollectiveCurrency.after).to.equal(15000);
      expect(anchorUpdate.changes).to.have.property('data.platformTip');
      expect(anchorUpdate.changes['data.platformTip'].before).to.equal(2250);
      expect(anchorUpdate.changes['data.platformTip'].after).to.equal(2200);

      // DEBIT CONTRIBUTION updates
      const debitUpdate = result.updates.find(u => u.id === 2);
      expect(debitUpdate).to.exist;
      expect(debitUpdate.changes.amount.before).to.equal(-15045);
      expect(debitUpdate.changes.amount.after).to.equal(-15000);

      // CREDIT PLATFORM_TIP updates
      const ptCreditUpdate = result.updates.find(u => u.id === 3);
      expect(ptCreditUpdate).to.exist;
      expect(ptCreditUpdate.changes.amount.before).to.equal(2250);
      expect(ptCreditUpdate.changes.amount.after).to.equal(2200);
      expect(ptCreditUpdate.changes.amountInHostCurrency.after).to.equal(Math.round(2200 * 0.6667));

      // DEBIT PLATFORM_TIP updates
      const ptDebitUpdate = result.updates.find(u => u.id === 4);
      expect(ptDebitUpdate).to.exist;
      expect(ptDebitUpdate.changes.amount.before).to.equal(-2250);
      expect(ptDebitUpdate.changes.amount.after).to.equal(-2200);
    });

    it('computes changes for USD async lag (amount mismatch, no platform tip)', () => {
      const tg = 'test-group-usd';
      const transactions = [
        // CREDIT CONTRIBUTION
        mockTransaction({
          id: 10,
          TransactionGroup: tg,
          kind: 'CONTRIBUTION',
          type: 'CREDIT',
          amount: 300,
          currency: 'USD',
          amountInHostCurrency: 100,
          hostCurrency: 'USD',
          hostCurrencyFxRate: 0.3333333333333333,
          netAmountInCollectiveCurrency: 300,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          taxAmount: 0,
          data: makeUsdChargeData({ amountCaptured: 100, platformTip: 0 }),
        }),
        // DEBIT CONTRIBUTION
        mockTransaction({
          id: 11,
          TransactionGroup: tg,
          kind: 'CONTRIBUTION',
          type: 'DEBIT',
          amount: -300,
          currency: 'USD',
          amountInHostCurrency: -100,
          hostCurrency: 'USD',
          hostCurrencyFxRate: 0.3333333333333333,
          netAmountInCollectiveCurrency: -300,
          HostCollectiveId: null,
        }),
      ];

      const result = computeGroupChanges(transactions);
      expect(result).to.not.be.null;
      expect(result.updates).to.have.length(2);

      // CREDIT CONTRIBUTION
      const anchorUpdate = result.updates.find(u => u.id === 10);
      expect(anchorUpdate).to.exist;
      expect(anchorUpdate.changes.amount.before).to.equal(300);
      expect(anchorUpdate.changes.amount.after).to.equal(100);
      expect(anchorUpdate.changes.hostCurrencyFxRate.before).to.equal(0.3333333333333333);
      expect(anchorUpdate.changes.hostCurrencyFxRate.after).to.equal(1);
      expect(anchorUpdate.changes.netAmountInCollectiveCurrency.before).to.equal(300);
      expect(anchorUpdate.changes.netAmountInCollectiveCurrency.after).to.equal(100);

      // DEBIT CONTRIBUTION
      const debitUpdate = result.updates.find(u => u.id === 11);
      expect(debitUpdate).to.exist;
      expect(debitUpdate.changes.amount.before).to.equal(-300);
      expect(debitUpdate.changes.amount.after).to.equal(-100);
      expect(debitUpdate.changes.netAmountInCollectiveCurrency.before).to.equal(-300);
      expect(debitUpdate.changes.netAmountInCollectiveCurrency.after).to.equal(-100);
    });

    it('handles DEBIT CONTRIBUTION with its own host (hosted contributor)', () => {
      const tg = 'test-group-hosted';
      const transactions = [
        mockTransaction({
          id: 20,
          TransactionGroup: tg,
          kind: 'CONTRIBUTION',
          type: 'CREDIT',
          amount: 300,
          currency: 'USD',
          amountInHostCurrency: 100,
          hostCurrency: 'USD',
          hostCurrencyFxRate: 0.3333333333333333,
          netAmountInCollectiveCurrency: 300,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          taxAmount: 0,
          data: makeUsdChargeData({ amountCaptured: 100 }),
        }),
        mockTransaction({
          id: 21,
          TransactionGroup: tg,
          kind: 'CONTRIBUTION',
          type: 'DEBIT',
          amount: -300,
          currency: 'USD',
          amountInHostCurrency: -150,
          hostCurrency: 'EUR',
          hostCurrencyFxRate: 0.5,
          netAmountInCollectiveCurrency: -300,
          HostCollectiveId: 999,
        }),
      ];

      const result = computeGroupChanges(transactions);
      expect(result).to.not.be.null;

      const debitUpdate = result.updates.find(u => u.id === 21);
      expect(debitUpdate).to.exist;
      // Hosted DEBIT keeps its own FX rate, but amounts are recalculated
      expect(debitUpdate.changes).to.not.have.property('hostCurrencyFxRate');
      expect(debitUpdate.changes.amount.after).to.equal(-100);
      expect(debitUpdate.changes.netAmountInCollectiveCurrency.after).to.equal(-100);
      // amountInHostCurrency = -correctNetAmount * debit's own fxRate
      expect(debitUpdate.changes.amountInHostCurrency.after).to.equal(-Math.round(100 * 0.5));
    });
  });

  describe('integration (database)', () => {
    before(async () => {
      await resetTestDB();
      await seedDefaultVendors();
    });

    it('fixes a JPY contribution with unrounded platform tip', async () => {
      const user = await fakeUser(null, { name: 'Contributor' });
      const host = await fakeHost({ name: 'JPY Host', currency: 'JPY' });
      const collective = await fakeCollective({
        name: 'JPY Collective',
        currency: 'JPY',
        HostCollectiveId: host.id,
      });

      const tg = uuid();
      const chargeData = makeJpyChargeData();

      const creditContribution = await fakeTransaction(
        {
          TransactionGroup: tg,
          kind: TransactionKind.CONTRIBUTION,
          type: 'CREDIT',
          amount: 15000,
          currency: 'JPY',
          amountInHostCurrency: 15000,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 0.9971014492753624,
          netAmountInCollectiveCurrency: 15045,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          CreatedByUserId: user.id,
          data: chargeData,
        },
        { createDoubleEntry: false },
      );

      await fakeTransaction(
        {
          TransactionGroup: tg,
          kind: TransactionKind.CONTRIBUTION,
          type: 'DEBIT',
          amount: -15045,
          currency: 'JPY',
          amountInHostCurrency: -15045,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 0.9971014492753624,
          netAmountInCollectiveCurrency: -15000,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          FromCollectiveId: collective.id,
          CollectiveId: user.CollectiveId,
          HostCollectiveId: null,
          CreatedByUserId: user.id,
          data: chargeData,
        },
        { createDoubleEntry: false },
      );

      // Run the script in non-dry-run mode with --apply-all
      process.env.DRY_RUN = 'false';
      try {
        await main([
          'node',
          'scripts/stripe/fix-invalid-amounts.ts',
          '--apply-all',
          '--groups',
          tg,
          '--fromDate',
          '2020-01-01',
        ]);
      } finally {
        process.env.DRY_RUN = 'true';
      }

      // Verify the CREDIT CONTRIBUTION was fixed
      const updatedCredit = await models.Transaction.findByPk(creditContribution.id);
      expect(updatedCredit.hostCurrencyFxRate).to.equal(1);
      expect(updatedCredit.netAmountInCollectiveCurrency).to.equal(15000);
      expect(updatedCredit.amount).to.equal(15000);
      expect(updatedCredit.data.platformTip).to.equal(2200);
      expect(updatedCredit.data.fixedByStripeInvalidOrderAmountScript).to.exist;
      expect(updatedCredit.data.fixedByStripeInvalidOrderAmountScript.previousValues).to.have.property(
        'hostCurrencyFxRate',
      );

      // Verify the DEBIT CONTRIBUTION was fixed
      const updatedDebit = await models.Transaction.findOne({
        where: { TransactionGroup: tg, kind: 'CONTRIBUTION', type: 'DEBIT' },
      });
      expect(updatedDebit.amount).to.equal(-15000);
      expect(updatedDebit.data.fixedByStripeInvalidOrderAmountScript).to.exist;
    });

    it('fixes a USD contribution with amount mismatch', async () => {
      const user = await fakeUser(null, { name: 'Contributor 2' });
      const host = await fakeHost({ name: 'USD Host', currency: 'USD' });
      const collective = await fakeCollective({
        name: 'USD Collective',
        currency: 'USD',
        HostCollectiveId: host.id,
      });

      const tg = uuid();
      const chargeData = makeUsdChargeData({ amountCaptured: 100, platformTip: 0 });

      const creditContribution = await fakeTransaction(
        {
          TransactionGroup: tg,
          kind: TransactionKind.CONTRIBUTION,
          type: 'CREDIT',
          amount: 300,
          currency: 'USD',
          amountInHostCurrency: 100,
          hostCurrency: 'USD',
          hostCurrencyFxRate: 0.3333333333333333,
          netAmountInCollectiveCurrency: 300,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          CreatedByUserId: user.id,
          data: chargeData,
        },
        { createDoubleEntry: false },
      );

      await fakeTransaction(
        {
          TransactionGroup: tg,
          kind: TransactionKind.CONTRIBUTION,
          type: 'DEBIT',
          amount: -300,
          currency: 'USD',
          amountInHostCurrency: -100,
          hostCurrency: 'USD',
          hostCurrencyFxRate: 0.3333333333333333,
          netAmountInCollectiveCurrency: -300,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          FromCollectiveId: collective.id,
          CollectiveId: user.CollectiveId,
          HostCollectiveId: null,
          CreatedByUserId: user.id,
          data: chargeData,
        },
        { createDoubleEntry: false },
      );

      process.env.DRY_RUN = 'false';
      try {
        await main([
          'node',
          'scripts/stripe/fix-invalid-amounts.ts',
          '--apply-all',
          '--groups',
          tg,
          '--fromDate',
          '2020-01-01',
        ]);
      } finally {
        process.env.DRY_RUN = 'true';
      }

      const updatedCredit = await models.Transaction.findByPk(creditContribution.id);
      expect(updatedCredit.amount).to.equal(100);
      expect(updatedCredit.amountInHostCurrency).to.equal(100);
      expect(updatedCredit.hostCurrencyFxRate).to.equal(1);
      expect(updatedCredit.netAmountInCollectiveCurrency).to.equal(100);
      expect(updatedCredit.data.fixedByStripeInvalidOrderAmountScript).to.exist;
      expect(updatedCredit.data.fixedByStripeInvalidOrderAmountScript.previousValues.amount).to.equal(300);

      const updatedDebit = await models.Transaction.findOne({
        where: { TransactionGroup: tg, kind: 'CONTRIBUTION', type: 'DEBIT' },
      });
      expect(updatedDebit.amount).to.equal(-100);
      expect(updatedDebit.netAmountInCollectiveCurrency).to.equal(-100);
    });

    it('fixes a JPY contribution where platformTipInHostCurrency was left stale by a previous run', async () => {
      const user = await fakeUser(null, { name: 'Contributor Stale' });
      const host = await fakeHost({ name: 'JPY Host Stale', currency: 'JPY' });
      const collective = await fakeCollective({
        name: 'JPY Collective Stale',
        currency: 'JPY',
        HostCollectiveId: host.id,
      });

      const tg = uuid();
      // Represents post-first-pass state: platformTip already corrected but
      // platformTipInHostCurrency still stale, causing amountInHostCurrency divergence.
      const chargeData = makeJpyChargeData({
        amountCaptured: 287,
        platformTip: 3700,
        platformTipInHostCurrency: 3743,
        btAmount: 287,
      });

      const creditContribution = await fakeTransaction(
        {
          TransactionGroup: tg,
          kind: TransactionKind.CONTRIBUTION,
          type: 'CREDIT',
          amount: 25000,
          currency: 'JPY',
          amountInHostCurrency: 24957,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: 23957,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: -1000,
          platformFeeInHostCurrency: 0,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          CreatedByUserId: user.id,
          data: chargeData,
        },
        { createDoubleEntry: false },
      );

      await fakeTransaction(
        {
          TransactionGroup: tg,
          kind: TransactionKind.CONTRIBUTION,
          type: 'DEBIT',
          amount: -23957,
          currency: 'JPY',
          amountInHostCurrency: -23957,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: -25000,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: -1000,
          platformFeeInHostCurrency: 0,
          FromCollectiveId: collective.id,
          CollectiveId: user.CollectiveId,
          HostCollectiveId: null,
          CreatedByUserId: user.id,
          data: chargeData,
        },
        { createDoubleEntry: false },
      );

      process.env.DRY_RUN = 'false';
      try {
        await main([
          'node',
          'scripts/stripe/fix-invalid-amounts.ts',
          '--apply-all',
          '--groups',
          tg,
          '--fromDate',
          '2020-01-01',
        ]);
      } finally {
        process.env.DRY_RUN = 'true';
      }

      const updatedCredit = await models.Transaction.findByPk(creditContribution.id);
      expect(updatedCredit.amount).to.equal(25000);
      expect(updatedCredit.amountInHostCurrency).to.equal(25000);
      expect(updatedCredit.hostCurrencyFxRate).to.equal(1);
      expect(updatedCredit.netAmountInCollectiveCurrency).to.equal(24000);
      expect(updatedCredit.data.platformTipInHostCurrency).to.equal(3700);
      expect(updatedCredit.data.fixedByStripeInvalidOrderAmountScript).to.exist;
      expect(updatedCredit.data.fixedByStripeInvalidOrderAmountScript.previousValues).to.deep.include({
        'data.platformTipInHostCurrency': 3743,
        amountInHostCurrency: 24957,
        netAmountInCollectiveCurrency: 23957,
      });

      const updatedDebit = await models.Transaction.findOne({
        where: { TransactionGroup: tg, kind: 'CONTRIBUTION', type: 'DEBIT' },
      });
      expect(updatedDebit.amount).to.equal(-24000);
      expect(updatedDebit.data.fixedByStripeInvalidOrderAmountScript).to.exist;
    });

    it('fixes a JPY contribution where charge lacks amount_captured (older Stripe API)', async () => {
      const user = await fakeUser(null, { name: 'Contributor No AmtCaptured' });
      const host = await fakeHost({ name: 'JPY Host No AmtCaptured', currency: 'JPY' });
      const collective = await fakeCollective({
        name: 'JPY Collective No AmtCaptured',
        currency: 'JPY',
        HostCollectiveId: host.id,
      });

      const tg = uuid();
      const chargeData = makeJpyChargeData({
        amountCaptured: 10000,
        omitAmountCaptured: true,
        platformTip: 0,
        platformTipInHostCurrency: null,
        btAmount: 10000,
      });

      const creditContribution = await fakeTransaction(
        {
          TransactionGroup: tg,
          kind: TransactionKind.CONTRIBUTION,
          type: 'CREDIT',
          amount: 10000,
          currency: 'JPY',
          amountInHostCurrency: 10000,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: 10000,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          CreatedByUserId: user.id,
          data: chargeData,
        },
        { createDoubleEntry: false },
      );

      await fakeTransaction(
        {
          TransactionGroup: tg,
          kind: TransactionKind.CONTRIBUTION,
          type: 'DEBIT',
          amount: -10000,
          currency: 'JPY',
          amountInHostCurrency: -10000,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: -10000,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          FromCollectiveId: collective.id,
          CollectiveId: user.CollectiveId,
          HostCollectiveId: null,
          CreatedByUserId: user.id,
          data: chargeData,
        },
        { createDoubleEntry: false },
      );

      process.env.DRY_RUN = 'false';
      try {
        await main([
          'node',
          'scripts/stripe/fix-invalid-amounts.ts',
          '--apply-all',
          '--groups',
          tg,
          '--fromDate',
          '2020-01-01',
        ]);
      } finally {
        process.env.DRY_RUN = 'true';
      }

      const updatedCredit = await models.Transaction.findByPk(creditContribution.id);
      // charge.amount=10000 JPY → convertFromStripeAmount('JPY', 10000) = 1000000 OC units
      expect(updatedCredit.amount).to.equal(1000000);
      expect(updatedCredit.amountInHostCurrency).to.equal(1000000);
      expect(updatedCredit.hostCurrencyFxRate).to.equal(1);
      expect(updatedCredit.netAmountInCollectiveCurrency).to.equal(1000000);
      expect(updatedCredit.data.fixedByStripeInvalidOrderAmountScript).to.exist;
    });

    it('fixes a JPY contribution where platformTip was stored in Stripe units', async () => {
      const user = await fakeUser(null, { name: 'Contributor Stripe Units' });
      const host = await fakeHost({ name: 'JPY Host Stripe Units', currency: 'JPY' });
      const collective = await fakeCollective({
        name: 'JPY Collective Stripe Units',
        currency: 'JPY',
        HostCollectiveId: host.id,
      });

      const tg = uuid();
      const chargeData = makeJpyChargeData({
        amountCaptured: 2300,
        applicationFeeAmount: 300,
        platformTip: 300,
        platformTipInHostCurrency: null,
        btAmount: 2300,
      });

      const creditContribution = await fakeTransaction(
        {
          TransactionGroup: tg,
          kind: TransactionKind.CONTRIBUTION,
          type: 'CREDIT',
          // Simulates the post-first-fix state: amount was incorrectly computed as
          // 2300*100 - 300 = 229700 instead of 2300*100 - 30000 = 200000
          amount: 229700,
          currency: 'JPY',
          amountInHostCurrency: 229700,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: 229700,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          CreatedByUserId: user.id,
          data: chargeData,
        },
        { createDoubleEntry: false },
      );

      await fakeTransaction(
        {
          TransactionGroup: tg,
          kind: TransactionKind.CONTRIBUTION,
          type: 'DEBIT',
          amount: -229700,
          currency: 'JPY',
          amountInHostCurrency: -229700,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: -229700,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          FromCollectiveId: collective.id,
          CollectiveId: user.CollectiveId,
          HostCollectiveId: null,
          CreatedByUserId: user.id,
          data: chargeData,
        },
        { createDoubleEntry: false },
      );

      await fakeTransaction(
        {
          TransactionGroup: tg,
          kind: TransactionKind.PLATFORM_TIP,
          type: 'CREDIT',
          amount: 300,
          currency: 'JPY',
          amountInHostCurrency: 300,
          hostCurrency: 'JPY',
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: 300,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          CreatedByUserId: user.id,
          data: chargeData,
        },
        { createDoubleEntry: false },
      );

      process.env.DRY_RUN = 'false';
      try {
        await main([
          'node',
          'scripts/stripe/fix-invalid-amounts.ts',
          '--apply-all',
          '--groups',
          tg,
          '--fromDate',
          '2020-01-01',
        ]);
      } finally {
        process.env.DRY_RUN = 'true';
      }

      const updatedCredit = await models.Transaction.findByPk(creditContribution.id);
      // correctPlatformTip = convertFromStripeAmount('JPY', 300) = 30000
      // correctAmount = 230000 - 30000 = 200000
      expect(updatedCredit.amount).to.equal(200000);
      expect(updatedCredit.amountInHostCurrency).to.equal(200000);
      expect(updatedCredit.netAmountInCollectiveCurrency).to.equal(200000);
      expect(updatedCredit.data.platformTip).to.equal(30000);
      expect(updatedCredit.data.fixedByStripeInvalidOrderAmountScript).to.exist;

      const updatedPlatformTip = await models.Transaction.findOne({
        where: { TransactionGroup: tg, kind: 'PLATFORM_TIP', type: 'CREDIT' },
      });
      expect(updatedPlatformTip.amount).to.equal(30000);
      expect(updatedPlatformTip.data.fixedByStripeInvalidOrderAmountScript).to.exist;
    });

    it('does not apply changes in dry-run mode', async () => {
      const user = await fakeUser(null, { name: 'Contributor 3' });
      const host = await fakeHost({ name: 'DryRun Host', currency: 'USD' });
      const collective = await fakeCollective({
        name: 'DryRun Collective',
        currency: 'USD',
        HostCollectiveId: host.id,
      });

      const tg = uuid();
      const chargeData = makeUsdChargeData({ amountCaptured: 100, platformTip: 0 });

      const creditContribution = await fakeTransaction(
        {
          TransactionGroup: tg,
          kind: TransactionKind.CONTRIBUTION,
          type: 'CREDIT',
          amount: 300,
          currency: 'USD',
          amountInHostCurrency: 100,
          hostCurrency: 'USD',
          hostCurrencyFxRate: 0.3333333333333333,
          netAmountInCollectiveCurrency: 300,
          hostFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          CreatedByUserId: user.id,
          data: chargeData,
        },
        { createDoubleEntry: false },
      );

      // DRY_RUN is default (true)
      delete process.env.DRY_RUN;
      try {
        await main([
          'node',
          'scripts/stripe/fix-invalid-amounts.ts',
          '--apply-all',
          '--groups',
          tg,
          '--fromDate',
          '2020-01-01',
        ]);
      } finally {
        process.env.DRY_RUN = 'true';
      }

      // Values should be unchanged
      const unchanged = await models.Transaction.findByPk(creditContribution.id);
      expect(unchanged.amount).to.equal(300);
      expect(unchanged.hostCurrencyFxRate).to.equal(0.3333333333333333);
      expect(unchanged.data.fixedByStripeInvalidOrderAmountScript).to.not.exist;
    });

    it('--report prints a per-collective impact table grouped by collective', async () => {
      const user = await fakeUser(null, { name: 'Report User' });
      const host = await fakeHost({ name: 'Report Host JPY', currency: 'JPY' });

      // collectiveA is active under the host
      const collectiveA = await fakeCollective({
        name: 'Report Collective A',
        currency: 'JPY',
        HostCollectiveId: host.id,
        isActive: true,
      });

      // collectiveB is inactive (isActive = false) - isActiveCollective should be false
      const collectiveB = await fakeCollective({
        name: 'Report Collective B',
        currency: 'JPY',
        HostCollectiveId: host.id,
        isActive: false,
      });

      const tg1 = uuid(); // collectiveA, group 1
      const tg2 = uuid(); // collectiveA, group 2 – tests aggregation across multiple groups
      const tg3 = uuid(); // collectiveB, group 1

      // tg1: collectiveA – JPY tip mismatch (platformTip 2250 → 2200, amount unchanged)
      const jpyChargeData = makeJpyChargeData();
      const makeJpyCreditParams = (collectiveId: number, tg: string) => ({
        TransactionGroup: tg,
        kind: TransactionKind.CONTRIBUTION,
        type: 'CREDIT' as const,
        amount: 15000,
        currency: 'JPY' as const,
        amountInHostCurrency: 15000,
        hostCurrency: 'JPY' as const,
        hostCurrencyFxRate: 0.9971014492753624,
        netAmountInCollectiveCurrency: 15045,
        hostFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collectiveId,
        HostCollectiveId: host.id,
        CreatedByUserId: user.id,
        data: jpyChargeData,
      });
      const makeJpyDebitParams = (collectiveId: number, tg: string) => ({
        TransactionGroup: tg,
        kind: TransactionKind.CONTRIBUTION,
        type: 'DEBIT' as const,
        amount: -15045,
        currency: 'JPY' as const,
        amountInHostCurrency: -15045,
        hostCurrency: 'JPY' as const,
        hostCurrencyFxRate: 0.9971014492753624,
        netAmountInCollectiveCurrency: -15000,
        hostFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        FromCollectiveId: collectiveId,
        CollectiveId: user.CollectiveId,
        HostCollectiveId: null,
        CreatedByUserId: user.id,
        data: jpyChargeData,
      });

      await fakeTransaction(makeJpyCreditParams(collectiveA.id, tg1), { createDoubleEntry: false });
      await fakeTransaction(makeJpyDebitParams(collectiveA.id, tg1), { createDoubleEntry: false });

      // tg2: collectiveA – second group to verify tipAmountChangesSum aggregates across groups
      await fakeTransaction(makeJpyCreditParams(collectiveA.id, tg2), { createDoubleEntry: false });
      await fakeTransaction(makeJpyDebitParams(collectiveA.id, tg2), { createDoubleEntry: false });

      // tg3: collectiveB – one group
      await fakeTransaction(makeJpyCreditParams(collectiveB.id, tg3), { createDoubleEntry: false });
      await fakeTransaction(makeJpyDebitParams(collectiveB.id, tg3), { createDoubleEntry: false });

      const tableStub = sinon.stub(console, 'table');
      try {
        await main([
          'node',
          'scripts/stripe/fix-invalid-amounts.ts',
          '--report',
          '--groups',
          `${tg1},${tg2},${tg3}`,
          '--fromDate',
          '2020-01-01',
        ]);
      } finally {
        tableStub.restore();
      }

      expect(tableStub.calledOnce).to.be.true;
      const rows: Array<Record<string, unknown>> = tableStub.firstCall.args[0];
      expect(rows).to.have.length(2);

      // collectiveA: 2 groups, each with tipDiff = 2200 - 2250 = -50; amount is unchanged (15000 → 15000)
      const rowA = rows.find(r => r.collectiveSlug === collectiveA.slug);
      expect(rowA, 'row for collectiveA').to.exist;
      expect(rowA.hostSlug).to.equal(host.slug);
      expect(rowA.isActiveCollective).to.be.true;
      expect(rowA.nbGroups).to.equal(2);
      expect(rowA.tipAmountChangesSum).to.equal(-100); // 2 × (2200 - 2250)
      expect(rowA.amountChangesSum).to.equal(0);

      // collectiveB: 1 group, isActive = false → isActiveCollective = false
      const rowB = rows.find(r => r.collectiveSlug === collectiveB.slug);
      expect(rowB, 'row for collectiveB').to.exist;
      expect(rowB.hostSlug).to.equal(host.slug);
      expect(rowB.isActiveCollective).to.be.false;
      expect(rowB.nbGroups).to.equal(1);
      expect(rowB.tipAmountChangesSum).to.equal(-50); // 1 × (2200 - 2250)
      expect(rowB.amountChangesSum).to.equal(0);
    });
  });
});

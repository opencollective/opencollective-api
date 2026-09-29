/* eslint-disable camelcase, custom-errors/no-unthrown-errors */
import * as Sentry from '@sentry/node';
import { expect } from 'chai';
import config from 'config';
import { createSandbox } from 'sinon';

import { TransferwiseError, ValidationFailed } from '../../../../server/graphql/errors';
import {
  buildMetricName,
  ErrorType,
  isValidMetricName,
  mapErrorToType,
  MetricDomain,
  MetricEvent,
  MetricFlow,
  MetricOrigin,
  MetricProvider,
  recordPaymentOutcome,
} from '../../../../server/lib/sentry/metrics';

describe('server/lib/sentry/metrics', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.stub(config, 'sentry').value({ dsn: 'https://sentry.io/123' });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('buildMetricName', () => {
    it('builds third-party payment metric names from the typed enums', () => {
      expect(
        buildMetricName({
          origin: MetricOrigin.THIRDPARTY,
          provider: MetricProvider.STRIPE,
          domain: MetricDomain.PAYMENT,
          event: MetricEvent.SUCCEEDED,
        }),
      ).to.equal('thirdparty.stripe.payment.succeeded');
    });

    it('builds internal metric names for the opencollective provider', () => {
      expect(
        buildMetricName({
          origin: MetricOrigin.INTERNAL,
          provider: MetricProvider.OPENCOLLECTIVE,
          domain: MetricDomain.PAYMENT,
          event: MetricEvent.FAILED,
        }),
      ).to.equal('internal.opencollective.payment.failed');
    });

    it('always produces 4 lowercase dot-separated segments', () => {
      const name = buildMetricName({
        origin: MetricOrigin.THIRDPARTY,
        provider: MetricProvider.WISE,
        domain: MetricDomain.PAYMENT,
        event: MetricEvent.FAILED,
      });
      expect(name.split('.')).to.have.length(4);
      expect(isValidMetricName(name)).to.be.true;
    });
  });

  describe('isValidMetricName', () => {
    it('accepts names matching the grammar', () => {
      expect(isValidMetricName('thirdparty.stripe.payment.succeeded')).to.be.true;
      expect(isValidMetricName('thirdparty.paypal.payment.failed')).to.be.true;
      expect(isValidMetricName('thirdparty.wise.payment.succeeded')).to.be.true;
      expect(isValidMetricName('internal.opencollective.payment.failed')).to.be.true;
      // Future domains/events stay within the grammar
      expect(isValidMetricName('thirdparty.stripe.api.duration')).to.be.true;
      expect(isValidMetricName('thirdparty.paypal.webhook.received')).to.be.true;
      expect(isValidMetricName('thirdparty.wise.payment.failed_2')).to.be.true;
    });

    it('rejects names that violate the grammar', () => {
      expect(isValidMetricName('')).to.be.false;
      expect(isValidMetricName('stripe.payment.succeeded')).to.be.false;
      expect(isValidMetricName('thirdparty.stripe.payment')).to.be.false;
      expect(isValidMetricName('thirdparty.stripe.payment.succeeded.extra')).to.be.false;
      expect(isValidMetricName('Thirdparty.stripe.payment.succeeded')).to.be.false;
      expect(isValidMetricName('thirdparty.stripe.payment.SUCCEEDED')).to.be.false;
      expect(isValidMetricName('thirdparty.unknown.payment.succeeded')).to.be.false;
      expect(isValidMetricName('thirdparty.stripe.unknown.succeeded')).to.be.false;
      expect(isValidMetricName('thirdparty.stripe.payment.succeeded!')).to.be.false;
      expect(isValidMetricName('third party.stripe.payment.succeeded')).to.be.false;
    });
  });

  describe('mapErrorToType', () => {
    it('returns unknown for empty errors', () => {
      expect(mapErrorToType(null)).to.equal(ErrorType.UNKNOWN);
      expect(mapErrorToType(undefined)).to.equal(ErrorType.UNKNOWN);
    });

    it('maps Stripe card error codes and decline codes', () => {
      expect(mapErrorToType({ code: 'card_declined' })).to.equal(ErrorType.CARD_DECLINED);
      expect(mapErrorToType({ code: 'insufficient_funds' })).to.equal(ErrorType.INSUFFICIENT_FUNDS);
      expect(mapErrorToType({ code: 'expired_card' })).to.equal(ErrorType.EXPIRED_CARD);
      expect(mapErrorToType({ decline_code: 'insufficient_funds' })).to.equal(ErrorType.INSUFFICIENT_FUNDS);
      expect(mapErrorToType({ decline_code: 'lost_card' })).to.equal(ErrorType.CARD_DECLINED);
    });

    it('maps card errors from message when the code was lost while wrapping', () => {
      expect(mapErrorToType(new Error('Your card was declined.'))).to.equal(ErrorType.CARD_DECLINED);
      expect(mapErrorToType(new Error('Your card has insufficient funds.'))).to.equal(ErrorType.INSUFFICIENT_FUNDS);
      expect(mapErrorToType(new Error('Your card has expired.'))).to.equal(ErrorType.EXPIRED_CARD);
    });

    it('maps Wise insufficient balance errors', () => {
      const wiseError = new TransferwiseError('Insufficient balance', 'INSUFFICIENT_BALANCE');
      expect(mapErrorToType(wiseError)).to.equal(ErrorType.INSUFFICIENT_BALANCE);
      expect(mapErrorToType({ extensions: { code: 'INSUFFICIENT_BALANCE' } })).to.equal(ErrorType.INSUFFICIENT_BALANCE);
    });

    it('maps other Wise errors to provider_error', () => {
      expect(mapErrorToType(new TransferwiseError('Bad request', 'transferwise.error.badRequest'))).to.equal(
        ErrorType.PROVIDER_ERROR,
      );
    });

    it('maps network errors', () => {
      expect(mapErrorToType({ code: 'ECONNRESET' })).to.equal(ErrorType.NETWORK_ERROR);
      expect(mapErrorToType({ code: 'ETIMEDOUT' })).to.equal(ErrorType.NETWORK_ERROR);
      expect(mapErrorToType({ code: 'ECONNREFUSED' })).to.equal(ErrorType.NETWORK_ERROR);
      expect(mapErrorToType(new Error('socket hang up'))).to.equal(ErrorType.NETWORK_ERROR);
      expect(mapErrorToType({ isAxiosError: true, request: {}, response: undefined })).to.equal(
        ErrorType.NETWORK_ERROR,
      );
    });

    it('maps validation errors', () => {
      expect(mapErrorToType(new ValidationFailed('Please verify the input data'))).to.equal(ErrorType.VALIDATION);
      expect(mapErrorToType({ name: 'ValidationError', message: 'invalid' })).to.equal(ErrorType.VALIDATION);
    });

    it('maps provider API errors', () => {
      expect(mapErrorToType({ type: 'StripeAPIError', message: 'api error' })).to.equal(ErrorType.PROVIDER_ERROR);
      expect(mapErrorToType({ code: 'api_error', message: 'Stripe is down' })).to.equal(ErrorType.PROVIDER_ERROR);
      expect(mapErrorToType({ metadata: { error: { details: [{ issue: 'INTERNAL_ERROR' }] } } })).to.equal(
        ErrorType.PROVIDER_ERROR,
      );
    });

    it('falls back to unknown for unrecognized errors', () => {
      expect(mapErrorToType(new Error('boom'))).to.equal(ErrorType.UNKNOWN);
      expect(mapErrorToType({ message: 'mystery' })).to.equal(ErrorType.UNKNOWN);
    });
  });

  describe('recordPaymentOutcome', () => {
    let countStub;

    beforeEach(() => {
      countStub = sandbox.stub(Sentry.metrics, 'count');
    });

    it('emits a counter named from the provider with flow and method attributes', () => {
      recordPaymentOutcome({
        provider: MetricProvider.STRIPE,
        flow: MetricFlow.CONTRIBUTION,
        method: 'creditcard',
        outcome: MetricEvent.SUCCEEDED,
      });

      expect(countStub).to.have.been.calledOnce;
      expect(countStub.firstCall.args).to.deep.equal([
        'thirdparty.stripe.payment.succeeded',
        1,
        { attributes: { flow: 'contribution', method: 'creditcard' } },
      ]);
    });

    it('emits payouts with their flow and payout method', () => {
      recordPaymentOutcome({
        provider: MetricProvider.WISE,
        flow: MetricFlow.PAYOUT,
        method: 'BANK_ACCOUNT',
        outcome: MetricEvent.SUCCEEDED,
      });

      expect(countStub.firstCall.args).to.deep.equal([
        'thirdparty.wise.payment.succeeded',
        1,
        { attributes: { flow: 'payout', method: 'BANK_ACCOUNT' } },
      ]);
    });

    it('adds error_type on failures', () => {
      recordPaymentOutcome({
        provider: MetricProvider.PAYPAL,
        flow: MetricFlow.PAYOUT,
        method: 'PAYPAL',
        outcome: MetricEvent.FAILED,
        errorType: ErrorType.PROVIDER_ERROR,
      });

      expect(countStub.firstCall.args).to.deep.equal([
        'thirdparty.paypal.payment.failed',
        1,
        { attributes: { flow: 'payout', method: 'PAYPAL', error_type: 'provider_error' } },
      ]);
    });

    it('defaults error_type to unknown on failures without one', () => {
      recordPaymentOutcome({
        provider: MetricProvider.STRIPE,
        flow: MetricFlow.CONTRIBUTION,
        method: 'paymentintent',
        outcome: MetricEvent.FAILED,
      });

      expect(countStub.firstCall.args[2].attributes.error_type).to.equal('unknown');
    });

    it('never includes error_type on successes', () => {
      recordPaymentOutcome({
        provider: MetricProvider.STRIPE,
        flow: MetricFlow.CONTRIBUTION,
        method: 'paymentintent',
        outcome: MetricEvent.SUCCEEDED,
        errorType: ErrorType.CARD_DECLINED,
      });

      expect(countStub.firstCall.args[2].attributes).to.not.have.property('error_type');
    });

    it('derives the internal origin for the opencollective provider', () => {
      recordPaymentOutcome({
        provider: MetricProvider.OPENCOLLECTIVE,
        flow: MetricFlow.PAYOUT,
        method: 'ACCOUNT_BALANCE',
        outcome: MetricEvent.SUCCEEDED,
      });

      expect(countStub.firstCall.args[0]).to.equal('internal.opencollective.payment.succeeded');
    });

    it('is a no-op when Sentry is not configured', () => {
      sandbox.stub(config, 'sentry').value({});
      recordPaymentOutcome({
        provider: MetricProvider.STRIPE,
        flow: MetricFlow.CONTRIBUTION,
        method: 'creditcard',
        outcome: MetricEvent.SUCCEEDED,
      });
      expect(countStub.called).to.be.false;
    });

    it('never throws when Sentry.metrics.count fails', () => {
      countStub.throws(new Error('metrics exploded'));
      expect(() =>
        recordPaymentOutcome({
          provider: MetricProvider.STRIPE,
          flow: MetricFlow.CONTRIBUTION,
          method: 'creditcard',
          outcome: MetricEvent.FAILED,
          errorType: ErrorType.CARD_DECLINED,
        }),
      ).to.not.throw();
    });
  });
});

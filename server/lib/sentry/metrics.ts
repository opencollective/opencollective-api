import * as Sentry from '@sentry/node';

import logger from '../logger';

import { checkIfSentryConfigured } from './init';

/**
 * Sentry metric name grammar: `<origin>.<provider>.<domain>.<event>` - lowercase, dot-separated,
 * always 4 segments. The origin segment keeps internal and third-party series from ever blending.
 * Centralized here so `beforeSendMetric` (init.ts) and the wrapper cannot drift.
 */
export const METRIC_NAME_REGEX =
  /^(thirdparty|internal)\.(stripe|paypal|wise|opencollective)\.(payment|api|webhook)\.[a-z0-9_]+$/;

export enum MetricOrigin {
  THIRDPARTY = 'thirdparty',
  INTERNAL = 'internal',
}

export enum MetricProvider {
  STRIPE = 'stripe',
  PAYPAL = 'paypal',
  WISE = 'wise',
  OPENCOLLECTIVE = 'opencollective',
}

export enum MetricDomain {
  PAYMENT = 'payment',
  API = 'api',
  WEBHOOK = 'webhook',
}

export enum MetricEvent {
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

export enum MetricFlow {
  CONTRIBUTION = 'contribution',
  PAYOUT = 'payout',
}

/** Low-cardinality taxonomy for `error_type` attributes - never raw provider messages. */
export enum ErrorType {
  CARD_DECLINED = 'card_declined',
  INSUFFICIENT_FUNDS = 'insufficient_funds',
  EXPIRED_CARD = 'expired_card',
  INSUFFICIENT_BALANCE = 'insufficient_balance',
  TRANSFER_CANCELLED = 'transfer_cancelled',
  FUNDS_REFUNDED = 'funds_refunded',
  PROVIDER_ERROR = 'provider_error',
  NETWORK_ERROR = 'network_error',
  VALIDATION = 'validation',
  UNKNOWN = 'unknown',
}

export function isValidMetricName(name: string): boolean {
  return typeof name === 'string' && METRIC_NAME_REGEX.test(name);
}

/** True for third-party providers. The `opencollective` service is internal - it must never be tagged `thirdparty`. */
function providerToOrigin(provider: MetricProvider): MetricOrigin {
  return provider === MetricProvider.OPENCOLLECTIVE ? MetricOrigin.INTERNAL : MetricOrigin.THIRDPARTY;
}

/** Maps a `PaymentMethod.service` value to a metric provider. Returns null for unknown services. */
export function paymentServiceToMetricProvider(service: string): MetricProvider | null {
  switch (service) {
    case 'stripe':
      return MetricProvider.STRIPE;
    case 'paypal':
      return MetricProvider.PAYPAL;
    case 'wise':
      return MetricProvider.WISE;
    case 'opencollective':
      return MetricProvider.OPENCOLLECTIVE;
    default:
      return null;
  }
}

export function buildMetricName(params: {
  origin: MetricOrigin;
  provider: MetricProvider;
  domain: MetricDomain;
  event: MetricEvent;
}): string {
  const name = `${params.origin}.${params.provider}.${params.domain}.${params.event}`;
  if (!isValidMetricName(name)) {
    throw new Error(`Invalid Sentry metric name: ${name}`);
  }
  return name;
}

const CARD_DECLINED_CODES = new Set([
  'card_declined',
  'do_not_honor',
  'generic_decline',
  'lost_card',
  'stolen_card',
  'fraudulent',
  'restricted_card',
  'security_violation',
  'service_not_allowed',
  'stop_payment_order',
  'card_velocity_exceeded',
  'incorrect_number',
  'invalid_number',
  'invalid_expiry_month',
  'invalid_expiry_year',
  'invalid_cvc',
  'incorrect_cvc',
  'incorrect_zip',
  'card_not_supported',
]);

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EAI_AGAIN',
  'ERR_NETWORK',
]);

const PROVIDER_ERROR_CODES = new Set([
  'api_error',
  'idempotency_error',
  'rate_limit_error',
  'authentication_error',
  'invalid_request_error',
  'upstream_error',
]);

/**
 * Maps an error to the low-cardinality `error_type` taxonomy. Understands the error shapes of the
 * payment providers (Stripe error `code`/`decline_code`, Wise `TransferwiseError` codes, PayPal
 * `metadata.error`, Axios/network errors) plus common wrapping that loses the original code.
 * Never returns raw messages - unrecognized errors map to `unknown`.
 */
export function mapErrorToType(error: unknown): ErrorType {
  if (!error) {
    return ErrorType.UNKNOWN;
  }

  const err = error as {
    code?: unknown;
    decline_code?: unknown; // eslint-disable-line camelcase
    type?: unknown;
    name?: unknown;
    message?: unknown;
    extensions?: { code?: unknown };
    metadata?: { error?: unknown };
    isAxiosError?: unknown;
    request?: unknown;
    response?: unknown;
  };
  const message = typeof error === 'string' ? error : String(err.message ?? '');
  const code = typeof err.code === 'string' ? err.code : '';
  const declineCode = typeof err.decline_code === 'string' ? err.decline_code : '';
  const extensionsCode = typeof err.extensions?.code === 'string' ? err.extensions.code : '';

  // Card errors (Stripe code/decline_code, or messages surviving our own error wrapping)
  if (code === 'insufficient_funds' || declineCode === 'insufficient_funds' || /insufficient funds/i.test(message)) {
    return ErrorType.INSUFFICIENT_FUNDS;
  }
  if (code === 'expired_card' || declineCode === 'expired_card' || /card has expired|expired card/i.test(message)) {
    return ErrorType.EXPIRED_CARD;
  }
  if (
    CARD_DECLINED_CODES.has(code) ||
    CARD_DECLINED_CODES.has(declineCode) ||
    /card was declined|card declined|do not honor/i.test(message)
  ) {
    return ErrorType.CARD_DECLINED;
  }

  // Wise host balance errors
  if (extensionsCode === 'INSUFFICIENT_BALANCE' || /insufficient balance/i.test(message)) {
    return ErrorType.INSUFFICIENT_BALANCE;
  }

  // Network errors
  if (
    NETWORK_ERROR_CODES.has(code) ||
    /socket hang up/i.test(message) ||
    (Boolean(err.isAxiosError) && !err.response && err.request)
  ) {
    return ErrorType.NETWORK_ERROR;
  }

  // Validation errors (our own errors, or model validation)
  if (
    err.name === 'ValidationError' ||
    err.name === 'ValidationFailed' ||
    extensionsCode === 'ValidationFailed' ||
    extensionsCode === 'Validation'
  ) {
    return ErrorType.VALIDATION;
  }

  // Provider API errors
  if (
    err.type === 'StripeConnectionError' ||
    (typeof err.type === 'string' && err.type.startsWith('Stripe')) ||
    PROVIDER_ERROR_CODES.has(code) ||
    Boolean(err.metadata?.error) ||
    (Boolean(err.isAxiosError) && Boolean(err.response)) ||
    extensionsCode.startsWith('transferwise.') ||
    message.startsWith('Wise:')
  ) {
    return ErrorType.PROVIDER_ERROR;
  }

  return ErrorType.UNKNOWN;
}

type PaymentOutcomeParams = {
  provider: MetricProvider;
  flow: MetricFlow;
  /** `order.paymentMethod.type` for contributions, `payoutMethod.type` for payouts */
  method: string;
  outcome: MetricEvent;
  /** Required on failures, ignored on successes. Defaults to `unknown`. */
  errorType?: ErrorType;
};

/**
 * Records a terminal third-party payment outcome (success/failure of a payment attempt).
 * Builds the metric name and attributes from the typed enums so they cannot drift.
 * Never throws: metrics must not break a payment. No-op when Sentry is not configured.
 */
export function recordPaymentOutcome(params: PaymentOutcomeParams): void {
  try {
    if (!checkIfSentryConfigured()) {
      return;
    }

    const name = buildMetricName({
      origin: providerToOrigin(params.provider),
      provider: params.provider,
      domain: MetricDomain.PAYMENT,
      event: params.outcome,
    });

    const attributes: Record<string, string> = {
      flow: params.flow,
      method: params.method,
    };
    if (params.outcome === MetricEvent.FAILED) {
      attributes.error_type = params.errorType || ErrorType.UNKNOWN; // eslint-disable-line camelcase
    }

    // NB: `@sentry/node` 11.0.0 has no `increment` API - counters are `count(name, 1)`
    Sentry.metrics.count(name, 1, { attributes });
  } catch (error) {
    logger.warn('sentry/metrics: failed to record payment outcome', error);
  }
}

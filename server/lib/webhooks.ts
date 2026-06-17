import dns from 'dns';
import http from 'http';
import https from 'https';

import config from 'config';
import ipaddr from 'ipaddr.js';
import { pick } from 'lodash';
import isIP from 'validator/lib/isIP';

import { activities } from '../constants';
import { RateLimitExceeded } from '../graphql/errors';
import { idEncode, IDENTIFIER_TYPES } from '../graphql/v2/identifiers';
import { Activity } from '../models';

import RateLimit, { ONE_HOUR_IN_SECONDS } from './rate-limit';
import { isTrustedWebhookProviderUrl } from './trusted-webhook-providers';
import { formatCurrency } from './utils';

export { isTrustedWebhookProviderUrl };

const DISALLOWED_WEBHOOK_HOSTNAME_SUFFIXES = ['.internal', '.localhost', '.local'];
const DISALLOWED_WEBHOOK_HOSTNAMES = new Set(['localhost']);
const DISALLOWED_IP_RANGES = new Set([
  'broadcast',
  'carrierGradeNat',
  'linkLocal',
  'loopback',
  'multicast',
  'private',
  'reserved',
  'uniqueLocal',
  'unspecified',
]);

export class WebhookUrlNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlNotAllowedError';
  }
}

export const isDisallowedWebhookHostname = (hostname: string): boolean => {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');

  if (DISALLOWED_WEBHOOK_HOSTNAMES.has(normalizedHostname)) {
    return true;
  }

  return DISALLOWED_WEBHOOK_HOSTNAME_SUFFIXES.some(suffix => normalizedHostname.endsWith(suffix));
};

export const isDisallowedWebhookIpAddress = (ip: string): boolean => {
  let address: ipaddr.IPv4 | ipaddr.IPv6;

  try {
    address = ipaddr.parse(ip);
  } catch {
    return true;
  }

  if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
    address = (address as ipaddr.IPv6).toIPv4Address();
  }

  return DISALLOWED_IP_RANGES.has(address.range());
};

const parseWebhookHttpUrl = (url: string): URL => {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookUrlNotAllowedError('Webhook URL must be a valid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new WebhookUrlNotAllowedError('Webhook URL must use HTTP or HTTPS');
  }

  if (!parsed.hostname) {
    throw new WebhookUrlNotAllowedError('Webhook URL must include a hostname');
  }

  if (isIP(parsed.hostname)) {
    throw new WebhookUrlNotAllowedError('IP addresses cannot be used as webhooks');
  }

  if (isDisallowedWebhookHostname(parsed.hostname)) {
    throw new WebhookUrlNotAllowedError('Webhook URL hostname is not allowed');
  }

  return parsed;
};

const resolveWebhookHostnameAddresses = async (hostname: string): Promise<string[]> => {
  const [ipv4Result, ipv6Result] = await Promise.allSettled([
    dns.promises.resolve4(hostname),
    dns.promises.resolve6(hostname),
  ]);
  const addresses = [
    ...(ipv4Result.status === 'fulfilled' ? ipv4Result.value : []),
    ...(ipv6Result.status === 'fulfilled' ? ipv6Result.value : []),
  ];

  if (addresses.length === 0) {
    const rejectedResult = [ipv4Result, ipv6Result].find(result => result.status === 'rejected') as
      | PromiseRejectedResult
      | undefined;
    const error = rejectedResult?.reason;
    throw new WebhookUrlNotAllowedError(
      `Webhook URL hostname could not be resolved: ${error?.message || 'unknown error'}`,
    );
  }

  return addresses;
};

const resolvePinnedWebhookAddresses = async (url: string): Promise<{ hostname: string; addresses: string[] }> => {
  const parsed = parseWebhookHttpUrl(url);
  const addresses = await resolveWebhookHostnameAddresses(parsed.hostname);

  for (const address of addresses) {
    if (isDisallowedWebhookIpAddress(address)) {
      throw new WebhookUrlNotAllowedError('Webhook URL resolves to a disallowed address');
    }
  }

  return { hostname: parsed.hostname, addresses };
};

type WebhookUrlValidationRateLimitContext = {
  userId?: number | null;
  collectiveId?: number | null;
};

const enforceWebhookUrlValidationRateLimit = async (context: WebhookUrlValidationRateLimitContext): Promise<void> => {
  const key = context.userId
    ? `webhook_url_validation_user_${context.userId}`
    : context.collectiveId
      ? `webhook_url_validation_collective_${context.collectiveId}`
      : null;

  if (!key) {
    return;
  }

  const rateLimit = new RateLimit(key, config.limits.webhookUrlValidationPerUserPerHour, ONE_HOUR_IN_SECONDS);
  if (!(await rateLimit.registerCall())) {
    throw new RateLimitExceeded('Too many webhook URL validations. Please wait before trying again.');
  }
};

export const assertWebhookUrlAllowed = async (
  url: string,
  context?: WebhookUrlValidationRateLimitContext,
): Promise<void> => {
  parseWebhookHttpUrl(url);

  if (isTrustedWebhookProviderUrl(url)) {
    return;
  }

  if (context) {
    await enforceWebhookUrlValidationRateLimit(context);
  }

  await resolvePinnedWebhookAddresses(url);
};

type DnsLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

const createPinnedHttpAgents = (addresses: string[]): { httpAgent: http.Agent; httpsAgent: https.Agent } => {
  const lookup = (hostname: string, options: dns.LookupOptions | number, callback: DnsLookupCallback) => {
    const lookupOptions = typeof options === 'object' ? options : { family: options };
    const family = lookupOptions.family;
    const pinnedAddresses = addresses
      .map(address => ({
        address,
        family: address.includes(':') ? 6 : 4,
      }))
      .filter(entry => {
        if (family === 4) {
          return entry.family === 4;
        } else if (family === 6) {
          return entry.family === 6;
        }

        return true;
      });

    if (pinnedAddresses.length === 0) {
      callback(new Error('Webhook URL has no allowed addresses for this address family'), '', 4);
      return;
    }

    if (lookupOptions.all) {
      callback(null, pinnedAddresses);
      return;
    }

    callback(null, pinnedAddresses[0].address, pinnedAddresses[0].family);
  };

  return {
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup }),
  };
};

export const getPinnedAxiosAgentsForWebhookUrl = async (
  url: string,
): Promise<{ httpAgent?: http.Agent; httpsAgent?: https.Agent }> => {
  if (isTrustedWebhookProviderUrl(url)) {
    return {};
  }

  const { addresses } = await resolvePinnedWebhookAddresses(url);
  return createPinnedHttpAgents(addresses);
};

/**
 * Filter collective public information, returning a minimal subset for incognito users
 */
const getCollectiveInfo = collective => {
  if (!collective) {
    return null;
  } else if (collective.isIncognito) {
    return pick(collective, ['type', 'name', 'image', 'previewImage']);
  } else {
    return {
      idV2: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT),
      ...pick(collective, [
        'publicId',
        'id',
        'type',
        'slug',
        'name',
        'company',
        'website',
        'twitterHandle',
        'githubHandle',
        'repositoryUrl',
        'description',
        'previewImage',
        'image',
      ]),
    };
  }
};

const getTierInfo = tier => {
  if (!tier) {
    return null;
  } else {
    return {
      idV2: idEncode(tier.id, IDENTIFIER_TYPES.TIER),
      ...pick(tier, ['id', 'name', 'amount', 'currency', 'description', 'maxQuantity', 'publicId']),
    };
  }
};

const getOrderInfo = order => {
  if (!order) {
    return null;
  } else {
    return {
      idV2: idEncode(order.id, IDENTIFIER_TYPES.ORDER),
      ...pick(order, [
        'publicId',
        'id',
        'totalAmount',
        'currency',
        'description',
        'tags',
        'interval',
        'createdAt',
        'quantity',
        'FromCollectiveId',
        'TierId',
      ]),
    };
  }
};

const getExpenseInfo = expense => {
  if (!expense) {
    return null;
  } else {
    return {
      idV2: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
      ...pick(expense, ['id', 'description', 'amount', 'currency', 'publicId']),
    };
  }
};

const getUpdateInfo = update => {
  if (!update) {
    return null;
  } else {
    return {
      idV2: idEncode(update.id, IDENTIFIER_TYPES.UPDATE),
      ...pick(update, ['html', 'title', 'slug', 'tags', 'isPrivate', 'publicId']),
    };
  }
};

const expenseActivities = [
  activities.COLLECTIVE_EXPENSE_CREATED,
  activities.COLLECTIVE_EXPENSE_DELETED,
  activities.COLLECTIVE_EXPENSE_UPDATED,
  activities.COLLECTIVE_EXPENSE_REJECTED,
  activities.COLLECTIVE_EXPENSE_INVITE_DECLINED,
  activities.COLLECTIVE_EXPENSE_APPROVED,
  activities.COLLECTIVE_EXPENSE_RE_APPROVAL_REQUESTED,
  activities.COLLECTIVE_EXPENSE_UNAPPROVED,
  activities.COLLECTIVE_EXPENSE_PAID,
  activities.COLLECTIVE_EXPENSE_MARKED_AS_UNPAID,
  activities.COLLECTIVE_EXPENSE_PROCESSING,
  activities.COLLECTIVE_EXPENSE_ERROR,
  activities.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT,
  activities.COLLECTIVE_EXPENSE_MARKED_AS_SPAM,
];

/**
 * Sanitize an activity to make it suitable for posting on external webhooks
 */
export const sanitizeActivityForWebhookPayload = (activity: Activity) => {
  // Fields commons to all activity types
  const cleanActivity: Pick<Activity, 'createdAt' | 'id' | 'type' | 'CollectiveId'> & {
    data?: Record<string, unknown>;
  } = pick(activity, ['createdAt', 'id', 'type', 'CollectiveId']);
  const type = cleanActivity.type;

  // Alway have an empty data object for activity
  cleanActivity.data = {};

  if (!activity.data) {
    return cleanActivity;
  }

  // Filter data based on activity type
  if (type === activities.COLLECTIVE_TRANSACTION_CREATED) {
    cleanActivity.data = pick(activity.data, ['transaction']); // It's safe to pick the entire transaction as it's added there through `transaction.info`, which only contains public fields
    cleanActivity.data.fromCollective = getCollectiveInfo(activity.data.fromCollective);
    cleanActivity.data.collective = getCollectiveInfo(activity.data.collective);
  } else if (type === activities.COLLECTIVE_UPDATE_PUBLISHED) {
    cleanActivity.data = { update: getUpdateInfo(activity.data.update) };
  } else if (expenseActivities.includes(type)) {
    cleanActivity.data = {
      expense: getExpenseInfo(activity.data.expense),
      fromCollective: getCollectiveInfo(activity.data.fromCollective),
      collective: getCollectiveInfo(activity.data.collective),
    };
  } else if (type === activities.COLLECTIVE_MEMBER_CREATED) {
    cleanActivity.data = pick(activity.data, ['member.role', 'member.description', 'member.since']);
    cleanActivity.data.order = getOrderInfo(activity.data.order);
    cleanActivity.data.member['memberCollective'] = getCollectiveInfo(activity.data.member.memberCollective);
    cleanActivity.data.member['tier'] = getTierInfo(activity.data.member.tier);
  } else if (type === activities.TICKET_CONFIRMED) {
    cleanActivity.data = pick(activity.data, ['recipient.name']);
    cleanActivity.data.tier = getTierInfo(activity.data.tier);
    cleanActivity.data.order = getOrderInfo(activity.data.order);
  } else if (type === activities.ORDER_PROCESSED) {
    cleanActivity.data = pick(activity.data, ['firstPayment']);
    cleanActivity.data.order = getOrderInfo(activity.data.order);
    cleanActivity.data.host = getCollectiveInfo(activity.data.host);
    cleanActivity.data.collective = getCollectiveInfo(activity.data.collective);
    cleanActivity.data.fromCollective = getCollectiveInfo(activity.data.fromCollective);
    if (activity.data.order?.TierId) {
      cleanActivity.data.tier = getTierInfo({ id: activity.data.order.TierId });
    }
  } else if (
    [activities.SUBSCRIPTION_CANCELED, activities.SUBSCRIPTION_PAUSED, activities.SUBSCRIPTION_RESUMED].includes(type)
  ) {
    cleanActivity.data = pick(activity.data, ['subscription.id']);
    cleanActivity.data.order = getOrderInfo(activity.data.order);
    cleanActivity.data.tier = getTierInfo(activity.data.tier);
  }

  return cleanActivity;
};

const enrichActivityData = data => {
  if (!data) {
    return null;
  }

  Object.entries(data).forEach(([key, value]) => {
    if (value && typeof value === 'object') {
      enrichActivityData(value);
    } else if ((key === 'amount' || key === 'totalAmount') && typeof value === 'number') {
      const amount = value;
      const currency = data['currency'];
      const interval = data['interval'];
      data.formattedAmount = currency ? formatCurrency(amount, currency, 2) : (amount / 100).toFixed(2);
      data.formattedAmountWithInterval = interval ? `${data.formattedAmount} / ${interval}` : data.formattedAmount;
    }
  });
};

/**
 * Adds user-friendly fields to an activity. Mutates activity.
 */
export const enrichActivityForWebhookPayload = activity => {
  enrichActivityData(activity.data);
  return activity;
};

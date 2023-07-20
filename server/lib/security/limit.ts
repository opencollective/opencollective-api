import config from 'config';
import debugLib from 'debug';
import { get } from 'lodash-es';
import validator from 'validator';

import { BadRequest } from '../../graphql/errors.js';
import cache from '../cache/index.js';
import { md5, sleep } from '../utils.js';

const debug = debugLib('security/limit');

const ONE_HOUR_IN_SECONDS = 60 * 60;

const getOrdersLimit = (
  order: {
    collective: { id: number };
    fromCollective?: { id: number };
    user: { email: string };
    guestInfo?: unknown;
  },
  reqIp: string,
  reqMask: string,
) => {
  const limits = [];

  const ordersLimits = config.limits.ordersPerHour;
  const collectiveId = get(order, 'collective.id');
  const fromCollectiveId = get(order, 'fromCollective.id');
  const userEmail = get(order, 'user.email');
  const guestInfo = get(order, 'guestInfo');

  if (fromCollectiveId) {
    // Limit on authenticated users
    limits.push({
      key: `order_limit_on_account_${fromCollectiveId}`,
      value: ordersLimits.perAccount,
    });
    if (collectiveId) {
      limits.push({
        key: `order_limit_on_account_${fromCollectiveId}_and_collective_${collectiveId}`,
        value: ordersLimits.perAccountForCollective,
      });
    }
  } else {
    // Limit on first time users
    if (userEmail) {
      const emailHash = md5(userEmail);
      limits.push({
        key: `order_limit_on_email_${emailHash}`,
        value: ordersLimits.perEmail,
      });
      if (collectiveId) {
        limits.push({
          key: `order_limit_on_email_${emailHash}_and_collective_${collectiveId}`,
          value: ordersLimits.perEmailForCollective,
        });
      }
    }
    // Limit on IPs
    if (reqIp) {
      limits.push({
        key: `order_limit_on_ip_${md5(reqIp)}`,
        value: ordersLimits.perIp,
      });
    }
  }

  if (reqMask && config.limits.enabledMasks.includes(reqMask)) {
    limits.push({
      key: `order_limit_on_mask_${reqMask}`,
      value: ordersLimits.perMask,
    });
  }

  // Guest Contributions
  if (guestInfo && collectiveId) {
    limits.push({
      key: `order_limit_to_account_${collectiveId}`,
      value: ordersLimits.forCollective,
    });
  }

  return limits;
};

export const checkOrdersLimit = async (
  order: {
    collective: { id: number };
    fromCollective?: { id: number };
    user: { email: string };
    guestInfo?: unknown;
  },
  reqIp,
  reqMask,
) => {
  if (['ci', 'test', 'e2e'].includes(config.env)) {
    return;
  }

  debug(`checkOrdersLimit reqIp:${reqIp} reqMask:${reqMask}`);

  // Generic error message
  // const errorMessage = 'Error while processing your request, please try again or contact support@opencollective.com.';
  const errorMessage = 'Your card was declined.';

  const limits = getOrdersLimit(order, reqIp, reqMask);
  for (const limit of limits) {
    const count = (await cache.get(limit.key)) || 0;
    debug(`${count} orders for limit '${limit.key}'`);
    const limitReached = count >= limit.value;
    cache.set(limit.key, count + 1, ONE_HOUR_IN_SECONDS);
    if (limitReached) {
      debug(`Order limit reached for limit '${limit.key}'`);
      // Slow down
      await sleep(Math.random() * 1000 * 5);
      // Show a developer-friendly message in DEV
      if (config.env === 'development') {
        throw new Error(`${errorMessage} Orders limit reached.`);
      } else {
        throw new Error(errorMessage);
      }
    }
  }
};

export const checkGuestContribution = async (
  order: {
    guestInfo?: {
      email: string;
    };
    fromCollective?: {
      id: number;
    };
    collective: {
      id: number;
    };
    paymentMethod?: {
      id?: number;
      uuid?: string;
    };
  },
  loaders,
) => {
  const { guestInfo } = order;

  const collective = order.collective.id && (await loaders.Collective.byId.load(order.collective.id));
  if (!collective) {
    throw new BadRequest('Guest contributions need to be made to an existing collective');
  }

  if (!guestInfo) {
    throw new BadRequest('You need to provide a guest profile with an email for logged out contributions');
  } else if (!guestInfo.email || !validator.default.isEmail(guestInfo.email)) {
    throw new BadRequest('You need to provide a valid email');
  } else if (order.fromCollective) {
    throw new BadRequest('You need to be logged in to specify a contributing profile');
  } else if (order.paymentMethod?.id || order.paymentMethod?.uuid) {
    throw new BadRequest('You need to be logged in to be able to use an existing payment method');
  }
};

export const cleanOrdersLimit = async (order, reqIp, reqMask) => {
  const limits = getOrdersLimit(order, reqIp, reqMask);

  for (const limit of limits) {
    cache.delete(limit.key);
  }
};

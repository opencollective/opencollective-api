import crypto from 'crypto';

import * as LibTaxes from '@opencollective/taxes';
import config from 'config';
import debugLib from 'debug';
import * as hcaptcha from 'hcaptcha';
import { get, isNil, omit, pick, set } from 'lodash';
import { isEmail } from 'validator';

import activities from '../../../constants/activities';
import CAPTCHA_PROVIDERS from '../../../constants/captcha-providers';
import { types } from '../../../constants/collectives';
import FEATURE from '../../../constants/feature';
import status from '../../../constants/order_status';
import roles from '../../../constants/roles';
import { VAT_OPTIONS } from '../../../constants/vat';
import cache, { purgeCacheForCollective } from '../../../lib/cache';
import * as github from '../../../lib/github';
import { getOrCreateGuestProfile } from '../../../lib/guest-accounts';
import logger from '../../../lib/logger';
import * as libPayments from '../../../lib/payments';
import recaptcha from '../../../lib/recaptcha';
import { getChargeRetryCount, getNextChargeAndPeriodStartDates } from '../../../lib/recurring-contributions';
import { canUseFeature } from '../../../lib/user-permissions';
import { formatCurrency, md5, parseToBoolean, sleep } from '../../../lib/utils';
import models from '../../../models';
import { canRefund } from '../../common/transactions';
import {
  BadRequest,
  FeatureNotAllowedForUser,
  Forbidden,
  NotFound,
  Unauthorized,
  ValidationFailed,
} from '../../errors';

const oneHourInSeconds = 60 * 60;

const debug = debugLib('orders');

export const ORDER_PUBLIC_DATA_FIELDS = {
  pledgeCurrency: 'thegivingblock.pledgeCurrency',
  pledgeAmount: 'thegivingblock.pledgeAmount',
};

function getOrdersLimit(order, reqIp, reqMask) {
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
}

async function checkOrdersLimit(order, reqIp, reqMask) {
  if (['ci', 'test'].includes(config.env)) {
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
    cache.set(limit.key, count + 1, oneHourInSeconds);
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
}

async function cleanOrdersLimit(order, reqIp, reqMask) {
  const limits = getOrdersLimit(order, reqIp, reqMask);

  for (const limit of limits) {
    cache.del(limit.key);
  }
}

const checkGuestContribution = async (order, loaders) => {
  const { guestInfo } = order;

  const collective = order.collective.id && (await loaders.Collective.byId.load(order.collective.id));
  if (!collective) {
    throw new BadRequest('Guest contributions need to be made to an existing collective');
  }

  if (!guestInfo) {
    throw new BadRequest('You need to provide a guest profile with an email for logged out contributions');
  } else if (!guestInfo.email || !isEmail(guestInfo.email)) {
    throw new BadRequest('You need to provide a valid email');
  } else if (order.totalAmount > 25000) {
    const location = guestInfo.location || {};
    if (!guestInfo.name) {
      throw new BadRequest('Contributions that are more than $250 must have a name attached');
    } else if (order.totalAmount > 500000 && !location.structured && (!location.address || !location.country)) {
      throw new BadRequest('Contributions that are more than $5000 must have an address attached');
    }
  } else if (order.fromCollective) {
    throw new BadRequest('You need to be logged in to specify a contributing profile');
  } else if (order.paymentMethod?.id || order.paymentMethod?.uuid) {
    throw new BadRequest('You need to be logged in to be able to use an existing payment method');
  }
};

async function checkCaptcha(order, remoteUser, reqIp) {
  const requestedProvider = order.guestInfo?.captcha?.provider;
  const isCaptchaEnabled = parseToBoolean(config.captcha?.enabled);

  if (!isCaptchaEnabled) {
    return;
  }

  if (!order.guestInfo?.captcha?.token) {
    throw new BadRequest('You need to inform a valid captcha token');
  }

  let response;
  if (requestedProvider === CAPTCHA_PROVIDERS.HCAPTCHA && config.hcaptcha?.secret) {
    response = await hcaptcha.verify(
      config.hcaptcha.secret,
      order.guestInfo.captcha.token,
      reqIp,
      config.hcaptcha.sitekey,
    );
  } else if (
    requestedProvider === CAPTCHA_PROVIDERS.RECAPTCHA &&
    config.recaptcha &&
    parseToBoolean(config.recaptcha.enable)
  ) {
    response = await recaptcha.verify(order.guestInfo.captcha.token, reqIp);
  } else {
    throw new BadRequest('Could not find requested Captcha provider', undefined, order.guestInfo?.captcha);
  }

  if (response.success !== true) {
    throw new BadRequest('Captcha verification failed');
  }

  return response;
}

/**
 * Check the taxes for order, returns the tax info
 */
const getTaxInfo = async (order, collective, host, tier, loaders) => {
  // Load optional data
  if (collective.ParentCollectiveId && !collective.parentCollective) {
    collective.parentCollective = await loaders.Collective.byId.load(collective.ParentCollectiveId);
  }

  const taxes = LibTaxes.getApplicableTaxes(collective, host, tier?.type);
  if (taxes.some(({ type }) => type === LibTaxes.TaxType.VAT)) {
    // ---- Taxes (VAT) ----
    const parentCollective = collective.parentCollective;
    let taxFromCountry = null;
    let taxPercent = 0;
    let vatSettings = {};

    // Load tax info from DB, ignore if amount is 0
    if (order.totalAmount !== 0 && tier && LibTaxes.isTierTypeSubjectToVAT(tier.type)) {
      const vatType = get(collective, 'settings.VAT.type') ?? get(collective.parentCollective, 'settings.VAT.type');
      const baseCountry = collective.countryISO || get(parentCollective, 'countryISO');
      if (vatType === VAT_OPTIONS.OWN) {
        taxFromCountry = LibTaxes.getVatOriginCountry(tier.type, baseCountry, baseCountry);
        vatSettings = { ...get(parentCollective, 'settings.VAT'), ...get(collective, 'settings.VAT') };
      } else if (vatType === VAT_OPTIONS.HOST) {
        const hostCountry = get(host, 'countryISO');
        taxFromCountry = LibTaxes.getVatOriginCountry(tier.type, hostCountry, baseCountry);
        vatSettings = get(host, 'settings.VAT') || {};
      }

      // Adapt tax based on country / tax ID number
      if (taxFromCountry) {
        if (!order.countryISO) {
          throw Error('This order has a tax attached, you must set a country');
        } else if (order.taxIDNumber && !LibTaxes.checkVATNumberFormat(order.taxIDNumber).isValid) {
          throw Error('Invalid VAT number');
        }

        const hasVatNumber = Boolean(order.taxIDNumber);
        taxPercent = LibTaxes.getVatPercentage(tier.type, taxFromCountry, order.countryISO, hasVatNumber);
      }
    }

    return {
      id: LibTaxes.TaxType.VAT,
      taxerCountry: taxFromCountry,
      taxedCountry: order.countryISO,
      percentage: taxPercent,
      taxIDNumber: order.taxIDNumber,
      taxIDNumberFrom: vatSettings.number,
    };
  } else if (taxes.some(({ type }) => type === LibTaxes.TaxType.GST)) {
    const hostGSTNumber = get(host, 'settings.GST.number');
    if (!hostGSTNumber) {
      throw new Error('GST tax is not enabled for this host');
    }

    return {
      id: LibTaxes.TaxType.VAT,
      taxerCountry: host.countryISO,
      taxedCountry: order.countryISO,
      percentage: LibTaxes.GST_RATE_PERCENT,
      taxIDNumber: order.taxIDNumber,
      taxIDNumberFrom: hostGSTNumber,
    };
  }
};

const hasPaymentMethod = order => {
  const { paymentMethod } = order;
  if (!paymentMethod) {
    return false;
  } else if (paymentMethod.service === 'paypal' && paymentMethod.type === 'payment') {
    return Boolean(paymentMethod.data?.orderId);
  } else {
    return Boolean(
      paymentMethod.uuid ||
        paymentMethod.token ||
        paymentMethod.type === 'manual' ||
        paymentMethod.type === 'alipay' ||
        paymentMethod.type === 'crypto',
    );
  }
};

export async function createOrder(order, loaders, remoteUser, reqIp, userAgent, reqMask) {
  debug('Beginning creation of order', order);

  if (remoteUser && !canUseFeature(remoteUser, FEATURE.ORDER)) {
    return new FeatureNotAllowedForUser();
  } else if (!remoteUser) {
    await checkGuestContribution(order, loaders);
  }

  await checkOrdersLimit(order, reqIp, reqMask);

  let orderCreated, isGuest, guestToken;
  try {
    // ---- Set defaults ----
    order.quantity = order.quantity || 1;
    order.taxAmount = order.taxAmount || 0;

    if (!order.collective || (!order.collective.id && !order.collective.website && !order.collective.githubHandle)) {
      throw new Error('No collective id/website/githubHandle provided');
    }

    const { id, githubHandle } = order.collective;

    if (!id && !githubHandle) {
      throw new ValidationFailed('An Open Collective id or a GitHub handle is mandatory.');
    }

    // Pledge to a GitHub organization or project
    if (githubHandle) {
      try {
        // Check Exists
        await github.checkGithubExists(githubHandle);
        // Check Stars
        await github.checkGithubStars(githubHandle);
      } catch (error) {
        throw new ValidationFailed(error.message);
      }
    }

    // Some tests are relying on this check being done at that point
    // Could be moved below at some point (see commented code)
    if (order.platformFeePercent && !remoteUser?.isRoot()) {
      throw new Error('Only a root can change the platformFeePercent');
    }

    // Check the existence of the recipient Collective
    let collective;
    if (order.collective.id) {
      collective = await loaders.Collective.byId.load(order.collective.id);
    } else if (order.collective.website) {
      collective = (
        await models.Collective.findOrCreate({
          where: { website: order.collective.website },
          defaults: order.collective,
        })
      )[0];
    } else if (order.collective.githubHandle) {
      collective = await models.Collective.findOne({ where: { githubHandle: order.collective.githubHandle } });
      if (!collective) {
        const allowed = ['slug', 'name', 'company', 'description', 'website', 'twitterHandle', 'githubHandle', 'tags'];
        collective = await models.Collective.create({
          ...pick(order.collective, allowed),
          type: types.COLLECTIVE,
          isPledged: true,
          data: { hasBeenPledged: true },
        });
      }
    }

    if (!collective) {
      throw new Error(`No collective found: ${order.collective.id || order.collective.website}`);
    }

    if (order.fromCollective && order.fromCollective.id === collective.id) {
      throw new Error('Orders cannot be created for a collective by that same collective.');
    }

    if (order.platformFee) {
      if (collective.platformFeePercent && !remoteUser?.isRoot()) {
        throw new Error('Only a root can set a platformFee on a collective with non-zero platformFee');
      }
    }

    const host = await collective.getHostCollective();
    if (order.hostFeePercent) {
      if (!remoteUser?.isAdmin(host.id)) {
        throw new Error('Only an admin of the host can change the hostFeePercent');
      }
    }

    order.collective = collective;

    let tier;
    if (order.tier) {
      tier = await models.Tier.findByPk(order.tier.id);
      if (!tier) {
        throw new Error(`No tier found with tier id: ${order.tier.id} for collective slug ${order.collective.slug}`);
      } else if (tier.CollectiveId !== collective.id) {
        throw new Error(
          `This tier (#${tier.id}) doesn't belong to the given Collective (${collective.name} #${collective.id})`,
        );
      }
    }

    const paymentRequired = (order.totalAmount > 0 || (tier && tier.amount > 0)) && collective.isActive;
    debug('paymentRequired', paymentRequired, 'total amount:', order.totalAmount, 'isActive', collective.isActive);
    if (paymentRequired && !hasPaymentMethod(order)) {
      throw new Error('This order requires a payment method');
    }

    if (tier) {
      const enoughQuantityAvailable = await tier.checkAvailableQuantity(order.quantity);
      if (!enoughQuantityAvailable) {
        throw new Error(`No more tickets left for ${tier.name}`);
      }
    }

    // find or create user, check permissions to set `fromCollective`
    let fromCollective;
    if (remoteUser && (!order.fromCollective || (!order.fromCollective.id && !order.fromCollective.name))) {
      fromCollective = await loaders.Collective.byId.load(remoteUser.CollectiveId);
    }

    // If a `fromCollective` is provided, we check its existence and if the user can create an order on its behalf
    if (order.fromCollective && order.fromCollective.id) {
      fromCollective = await loaders.Collective.byId.load(order.fromCollective.id);
      if (!fromCollective) {
        throw new Error(`From collective id ${order.fromCollective.id} not found`);
      }

      const possibleRoles = [];
      if (fromCollective.type === types.ORGANIZATION) {
        possibleRoles.push(roles.MEMBER);
      }

      if (!remoteUser?.isAdminOfCollective(fromCollective) && !remoteUser?.hasRole(possibleRoles, fromCollective.id)) {
        // We only allow to add funds on behalf of a collective if the user is an admin of that collective or an admin of the host of the collective that receives the money
        const HostId = await collective.getHostCollectiveId();
        if (!remoteUser?.isAdmin(HostId)) {
          throw new Error(
            `You don't have sufficient permissions to create an order on behalf of the ${
              fromCollective.name
            } ${fromCollective.type.toLowerCase()}`,
          );
        }
      }
    }

    let captchaResponse;
    if (!fromCollective) {
      if (remoteUser) {
        // @deprecated - Creating organizations inline from this endpoint should not be supported anymore
        logger.warn('createOrder: Inline org creation should not be used anymore');
        fromCollective = await models.Collective.createOrganization(order.fromCollective, remoteUser, remoteUser);
      } else {
        // Create or retrieve guest profile from GUEST_TOKEN
        const creationRequest = { ip: reqIp, userAgent, mask: reqMask };
        captchaResponse = await checkCaptcha(order, remoteUser, reqIp);
        const guestProfile = await getOrCreateGuestProfile(order.guestInfo, creationRequest);
        remoteUser = guestProfile.user;
        fromCollective = guestProfile.collective;
        isGuest = true;
        guestToken = crypto.randomBytes(48).toString('hex');
      }
    }

    const currency = (tier && tier.currency) || collective.currency;
    if (order.currency && order.currency !== currency) {
      throw new Error(`Invalid currency. Expected ${currency}.`);
    }

    // ---- Taxes ----
    const taxInfo = await getTaxInfo(order, collective, host, tier, loaders);
    const taxPercent = taxInfo?.percentage || 0;

    // Ensure tax amount is not out-of-bound
    if (order.taxAmount < 0) {
      throw Error('Tax amount cannot be negative');
    } else if (taxPercent === 0 && order.taxAmount !== 0) {
      throw Error(
        `This order should not have any tax attached. Received tax amount ${formatCurrency(order.taxAmount, currency)}`,
      );
    }

    // ---- Checks on totalAmount ----
    if (order.totalAmount < 0) {
      throw new Error('Total amount cannot be a negative value');
    }
    // Don't allow custom values if using a tier with fixed amount
    if (tier && tier.amount && !tier.presets) {
      // Manually force the totalAmount if it has not been passed
      if (isNil(order.totalAmount)) {
        order.totalAmount = Math.round(order.quantity * tier.amount * (1 + taxPercent / 100));
      }

      const netAmountForCollective = order.totalAmount - order.taxAmount - (order.platformFee || 0);
      const expectedAmountForCollective = order.quantity * tier.amount;
      const expectedTaxAmount = Math.round((expectedAmountForCollective * taxPercent) / 100);
      if (netAmountForCollective !== expectedAmountForCollective || order.taxAmount !== expectedTaxAmount) {
        const prettyTotalAmount = formatCurrency(order.totalAmount, currency, 2);
        const prettyExpectedAmount = formatCurrency(expectedAmountForCollective, currency, 2);
        const taxInfoStr = expectedTaxAmount ? ` + ${formatCurrency(expectedTaxAmount, currency, 2)} tax` : '';
        const platformFeeInfo = order.platformFee ? ` + ${formatCurrency(order.platformFee, currency, 2)} fees` : '';
        throw new Error(
          `This tier uses a fixed amount. Order total must be ${prettyExpectedAmount}${taxInfoStr}${platformFeeInfo}. You set: ${prettyTotalAmount}`,
        );
      }
    }

    // If using a tier, amount can never be less than the minimum amount
    if (tier && tier.minimumAmount) {
      const minAmount = tier.minimumAmount * order.quantity;
      const minTotalAmount = taxPercent ? Math.round(minAmount * (1 + taxPercent / 100)) : minAmount;
      if ((order.totalAmount || 0) < minTotalAmount) {
        const prettyMinTotal = formatCurrency(minTotalAmount, currency);
        throw new Error(`The amount you set is below minimum tier value, it should be at least ${prettyMinTotal}`);
      }
    }

    const defaultDescription = models.Order.generateDescription(collective, order.totalAmount, order.interval, tier);
    debug('defaultDescription', defaultDescription, 'collective.type', collective.type);

    // Default status, will get updated after the order is processed
    let orderStatus = status.NEW;
    // Special cases
    if (collective.isPledged) {
      orderStatus = status.PLEDGED;
    }
    if (get(order, 'paymentMethod.type') === 'manual') {
      orderStatus = status.PENDING;
    }

    let orderPublicData;
    if (order.data) {
      orderPublicData = pick(order.data, Object.values(ORDER_PUBLIC_DATA_FIELDS));
    }

    const orderData = {
      CreatedByUserId: remoteUser.id,
      FromCollectiveId: fromCollective.id,
      CollectiveId: collective.id,
      TierId: tier && tier.id,
      quantity: order.quantity,
      totalAmount: order.totalAmount,
      currency,
      taxAmount: taxInfo ? order.taxAmount : null,
      interval: order.interval,
      description: order.description || defaultDescription,
      publicMessage: order.publicMessage, // deprecated: '2019-07-03: This info is now stored at the Member level'
      privateMessage: order.privateMessage,
      processedAt: paymentRequired || !collective.isActive ? null : new Date(),
      tags: order.tags,
      data: {
        ...orderPublicData,
        reqIp,
        reqMask,
        captchaResponse,
        tax: taxInfo,
        customData: order.customData,
        savePaymentMethod: Boolean(!isGuest && order.paymentMethod?.save),
        isFeesOnTop: order.isFeesOnTop,
        guestToken, // For guest contributions, this token is a way to authenticate to confirm the order
        isEmbed: Boolean(order.context?.isEmbed),
        isGuest,
        isBalanceTransfer: order.isBalanceTransfer,
      },
      status: orderStatus,
    };

    // Handle specific fees
    // we use data instead of a column for now because it's an edge/experimental case
    // should be moved to a column if it starts to be widely used
    if (order.hostFeePercent) {
      orderData.data.hostFeePercent = order.hostFeePercent;
    } else if (tier && tier.data && tier.data.hostFeePercent !== undefined) {
      orderData.data.hostFeePercent = tier.data.hostFeePercent;
    }
    if (order.platformFee) {
      orderData.data.platformFee = order.platformFee;
    } else if (order.platformFeePercent) {
      orderData.data.platformFeePercent = order.platformFeePercent;
    } else if (tier && tier.data && tier.data.platformFeePercent !== undefined) {
      orderData.data.platformFeePercent = tier.data.platformFeePercent;
    }

    // Handle status for "free" orders
    if (orderData.totalAmount === 0) {
      orderData.status = order.interval ? status.ACTIVE : status.PAID;
    }

    orderCreated = await models.Order.create(orderData);

    if (paymentRequired) {
      if (get(order, 'paymentMethod.type') === 'manual') {
        orderCreated.paymentMethod = order.paymentMethod;
      } else {
        order.paymentMethod.CollectiveId = orderCreated.FromCollectiveId;
        if (get(order, 'paymentMethod.service') === 'stripe') {
          // For Stripe `save` will be manually set to `true`, in `processOrder` if the order succeed
          order.paymentMethod.saved = null;
        } else {
          order.paymentMethod.saved = Boolean(orderCreated.data.savePaymentMethod);
        }

        if (isGuest) {
          set(order.paymentMethod, 'data.isGuest', true);
        }

        await orderCreated.setPaymentMethod(order.paymentMethod);
      }
      // also adds the user as a BACKER of collective
      await libPayments.executeOrder(remoteUser, orderCreated);
    } else if (!paymentRequired && order.interval && collective.type === types.COLLECTIVE) {
      // create inactive subscription to hold the interval info for the pledge
      const subscription = await models.Subscription.create({
        amount: order.totalAmount,
        interval: order.interval,
        currency: order.currency,
      });
      await orderCreated.update({ SubscriptionId: subscription.id });
    } else if (collective.type === types.EVENT) {
      // Free ticket, mark as processed and add user as an ATTENDEE
      await orderCreated.update({ status: 'PAID', processedAt: new Date() });
      await collective.addUserWithRole(remoteUser, roles.ATTENDEE, {}, { order: orderCreated });
      await models.Activity.create({
        type: activities.TICKET_CONFIRMED,
        CollectiveId: collective.id,
        data: {
          EventCollectiveId: collective.id,
          UserId: remoteUser.id,
          recipient: { name: fromCollective.name },
          order: orderCreated.info,
          tier: tier && tier.info,
        },
      });
    }

    // Invalidate Cloudflare cache for the collective pages
    purgeCacheForCollective(collective.slug);
    purgeCacheForCollective(fromCollective.slug);

    const skipCleanOrdersLimitSlugs = config.limits.skipCleanOrdersLimitSlugs;

    if (!skipCleanOrdersLimitSlugs || !skipCleanOrdersLimitSlugs.includes(collective.slug)) {
      cleanOrdersLimit(order, reqIp, reqMask);
    }

    order = await models.Order.findByPk(orderCreated.id);

    return { order, guestToken };
  } catch (error) {
    if (orderCreated) {
      if (!orderCreated.processedAt) {
        if (error.stripeResponse) {
          orderCreated.status = status.REQUIRE_CLIENT_CONFIRMATION;
        } else {
          orderCreated.status = status.ERROR;
        }
        // This is not working
        // orderCreated.data.error = { message: error.message };
        // This is working
        orderCreated.data = { ...orderCreated.data, error: { message: error.message } };
        await orderCreated.save();
      }

      if (!error.stripeResponse) {
        throw error;
      }

      const stripeError = {
        message: error.message,
        account: error.stripeAccount,
        response: error.stripeResponse,
      };

      orderCreated.stripeError = stripeError;
      return { order: orderCreated, stripeError, guestToken };
    }

    throw error;
  }
}

export async function confirmOrder(order, remoteUser, guestToken) {
  if (remoteUser && !canUseFeature(remoteUser, FEATURE.ORDER)) {
    return new FeatureNotAllowedForUser();
  }

  order = await models.Order.findOne({
    where: {
      id: order.id,
    },
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'fromCollective' },
      { model: models.PaymentMethod, as: 'paymentMethod' },
      { model: models.Subscription, as: 'Subscription' },
      { association: 'createdByUser' },
    ],
  });

  if (!order) {
    throw new NotFound('Order not found');
  }

  if (!remoteUser) {
    if (!guestToken || guestToken !== order.data?.guestToken) {
      throw new Error('We could not authenticate your request');
    } else {
      // Guest token is verified, we can consider that request submitter is the owner of this order
      remoteUser = order.createdByUser;
    }
  } else if (!remoteUser.isAdmin(order.FromCollectiveId)) {
    throw new Unauthorized("You don't have permission to confirm this order");
  }

  if (![status.ERROR, status.PENDING, status.REQUIRE_CLIENT_CONFIRMATION].includes(order.status)) {
    // As August 2020, we're transitionning from PENDING to REQUIRE_CLIENT_CONFIRMATION
    // PENDING can be safely removed after a few days (it will be dedicated for "Manual" payments)
    throw new Error('Order can only be confirmed if its status is ERROR, PENDING or REQUIRE_CLIENT_CONFIRMATION.');
  }

  try {
    // If it's a first order -> executeOrder
    // If it's a recurring subscription and not the initial order -> processOrder
    if (!order.processedAt) {
      await libPayments.executeOrder(remoteUser, order);
      // executeOrder is updating the order to PAID
    } else {
      await libPayments.processOrder(order);

      order.status = status.ACTIVE;
      order.data = omit(order.data, ['error', 'latestError', 'paymentIntent']);
      order.Subscription = Object.assign(order.Subscription, getNextChargeAndPeriodStartDates('success', order));
      order.Subscription.chargeRetryCount = getChargeRetryCount('success', order);
      if (order.Subscription.chargeNumber !== null) {
        order.Subscription.chargeNumber += 1;
      }

      await order.Subscription.save();
      await order.save();
    }

    return order;
  } catch (error) {
    if (!error.stripeResponse) {
      throw error;
    }

    order.stripeError = {
      message: error.message,
      account: error.stripeAccount,
      response: error.stripeResponse,
    };

    return order;
  }
}

export async function refundTransaction(_, args, req) {
  // 0. Retrieve transaction from database
  const transaction = await models.Transaction.findByPk(args.id, {
    include: [models.Order, models.PaymentMethod],
  });

  if (!transaction) {
    throw new NotFound('Transaction not found');
  }

  // 1a. Verify user permission using canRefun. User must be either
  //   a. Admin of the collective that received the donation
  //   b. Admin of the Host Collective that received the donation
  //   c. Admin of opencollective.com/opencollective
  // 1b. Check transaction age - only Host admins can refund transactions older than 30 days
  // 1c. The transaction type must be CREDIT to prevent users from refunding their own DEBITs

  const canUserRefund = await canRefund(transaction, undefined, req);
  if (!canUserRefund) {
    throw new Forbidden('Cannot refund this transaction');
  }

  // 2. Refund via payment method
  // 3. Create new transactions with the refund value in our database
  const result = await libPayments.refundTransaction(transaction, req.remoteUser, args.message);

  // Return the transaction passed to the `refundTransaction` method
  // after it was updated.
  return result;
}

export async function markOrderAsPaid(remoteUser, id) {
  if (!remoteUser) {
    throw new Unauthorized();
  }

  // fetch the order
  const order = await models.Order.findByPk(id);
  if (!order) {
    throw new NotFound('Order not found');
  }
  if (order.status !== 'PENDING') {
    throw new ValidationFailed("The order's status must be PENDING");
  }

  const collective = await models.Collective.findByPk(order.CollectiveId);
  if (collective.isHostAccount) {
    if (!remoteUser.isAdmin(collective.id)) {
      throw new Unauthorized('You must be logged in as an admin of the host of the collective');
    }
  } else {
    const HostCollectiveId = await models.Collective.getHostCollectiveId(order.CollectiveId);
    if (!remoteUser.isAdmin(HostCollectiveId)) {
      throw new Unauthorized('You must be logged in as an admin of the host of the collective');
    }
  }

  order.paymentMethod = {
    service: 'opencollective',
    type: 'manual',
    paid: true,
  };
  /**
   * Takes care of:
   * - creating the transactions
   * - add backer as a BACKER in the Members table
   * - send confirmation email
   * - update order.status and order.processedAt
   */
  await libPayments.executeOrder(remoteUser, order);
  return order;
}

export async function markPendingOrderAsExpired(remoteUser, id) {
  if (!remoteUser) {
    throw new Unauthorized();
  }

  // fetch the order
  const order = await models.Order.findByPk(id);
  if (!order) {
    throw new NotFound('Order not found');
  }

  if (order.status !== 'PENDING') {
    throw new ValidationFailed("The order's status must be PENDING");
  }

  const collective = await models.Collective.findByPk(order.CollectiveId);
  if (collective.isHostAccount) {
    if (!remoteUser.isAdmin(collective.id)) {
      throw new Unauthorized('You must be logged in as an admin of the host of the collective');
    }
  } else {
    const HostCollectiveId = await models.Collective.getHostCollectiveId(order.CollectiveId);
    if (!remoteUser.isAdmin(HostCollectiveId)) {
      throw new Unauthorized('You must be logged in as an admin of the host of the collective');
    }
  }

  order.status = 'EXPIRED';
  await order.save();
  return order;
}

export async function addFundsToCollective(order, remoteUser) {
  if (!remoteUser) {
    throw new Error('You need to be logged in to add fund to collective');
  }

  if (order.totalAmount < 0) {
    throw new Error('Total amount cannot be a negative value');
  }

  const collective = await models.Collective.findByPk(order.collective.id);
  if (!collective) {
    throw new Error(`No collective found: ${order.collective.id}`);
  }

  const host = await collective.getHostCollective();
  if (!remoteUser.isAdmin(host.id) && !remoteUser.isRoot()) {
    throw new Error('Only an site admin or collective host admin can add fund');
  }

  order.collective = collective;
  let fromCollective, user;

  // @deprecated Users are normally not created inline anymore
  if (order.user && order.user.email) {
    logger.warn('addFundsToCollective: Inline user creation should not be used anymore');
    user = await models.User.findByEmail(order.user.email);
    if (!user) {
      user = await models.User.createUserWithCollective({
        ...order.user,
        currency: collective.currency,
        CreatedByUserId: remoteUser ? remoteUser.id : null,
      });
    }
  } else if (remoteUser) {
    user = remoteUser;
  }

  if (order.fromCollective.id) {
    fromCollective = await models.Collective.findByPk(order.fromCollective.id);
    if (!fromCollective) {
      throw new Error(`From collective id ${order.fromCollective.id} not found`);
    } else if (fromCollective.hasBudget()) {
      // Make sure logged in user is admin of the source profile, unless it doesn't have a budget (user
      // or host organization without budget activated). It's not an ideal solution though, as spammy
      // hosts could still use this to pollute user's ledgers.
      const isAdminOfFromCollective = remoteUser.isRoot() || remoteUser.isAdmin(fromCollective.id);
      if (!isAdminOfFromCollective && fromCollective.HostCollectiveId !== host.id) {
        const fromCollectiveHostId = await fromCollective.getHostCollectiveId();
        if (!remoteUser.isAdmin(fromCollectiveHostId) && !host.data?.allowAddFundsFromAllAccounts) {
          throw new Error(
            "You don't have the permission to add funds from accounts you don't own or host. Please contact support@opencollective.com if you want to enable this.",
          );
        }
      }
    }
  } else {
    fromCollective = await models.Collective.createOrganization(order.fromCollective, user, remoteUser);
  }

  const orderData = {
    CreatedByUserId: remoteUser.id || user.id,
    FromCollectiveId: fromCollective.id,
    CollectiveId: collective.id,
    totalAmount: order.totalAmount,
    currency: collective.currency,
    description: order.description,
    status: status.NEW,
    data: {},
  };

  // Handle specific fees
  if (!isNil(order.hostFeePercent)) {
    orderData.data.hostFeePercent = order.hostFeePercent;
  }

  const orderCreated = await models.Order.create(orderData);

  const hostPaymentMethod = await host.getOrCreateHostPaymentMethod();
  await orderCreated.setPaymentMethod({ uuid: hostPaymentMethod.uuid });

  await libPayments.executeOrder(remoteUser || user, orderCreated);

  // Invalidate Cloudflare cache for the collective pages
  purgeCacheForCollective(collective.slug);
  purgeCacheForCollective(fromCollective.slug);

  return models.Order.findByPk(orderCreated.id);
}

import crypto from 'crypto';

import * as LibTaxes from '@opencollective/taxes';
import config from 'config';
import debugLib from 'debug';
import * as hcaptcha from 'hcaptcha';
import { get, isEmpty, isEqual, isNil, omit, pick, set } from 'lodash';

import activities from '../../../constants/activities';
import CAPTCHA_PROVIDERS from '../../../constants/captcha-providers';
import { types } from '../../../constants/collectives';
import FEATURE from '../../../constants/feature';
import status from '../../../constants/order_status';
import { PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import roles from '../../../constants/roles';
import { VAT_OPTIONS } from '../../../constants/vat';
import { purgeCacheForCollective } from '../../../lib/cache';
import * as github from '../../../lib/github';
import { getOrCreateGuestProfile } from '../../../lib/guest-accounts';
import logger from '../../../lib/logger';
import * as libPayments from '../../../lib/payments';
import recaptcha from '../../../lib/recaptcha';
import { getChargeRetryCount, getNextChargeAndPeriodStartDates } from '../../../lib/recurring-contributions';
import { checkGuestContribution, checkOrdersLimit, cleanOrdersLimit } from '../../../lib/security/limit';
import { orderFraudProtection } from '../../../lib/security/order';
import { reportErrorToSentry } from '../../../lib/sentry';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import { canUseFeature } from '../../../lib/user-permissions';
import { formatCurrency, parseToBoolean } from '../../../lib/utils';
import models from '../../../models';
import { canRefund } from '../../common/transactions';
import {
  BadRequest,
  FeatureNotAllowedForUser,
  FeatureNotSupportedForCollective,
  Forbidden,
  NotFound,
  Unauthorized,
  ValidationFailed,
} from '../../errors';

const debug = debugLib('orders');

export const ORDER_PUBLIC_DATA_FIELDS = {
  pledgeCurrency: 'thegivingblock.pledgeCurrency',
  pledgeAmount: 'thegivingblock.pledgeAmount',
};

const mustUpdateLocation = (existingLocation, newLocation) => {
  const simpleFields = ['country', 'name', 'address'];
  const hasUpdatedSimpleField = field => newLocation[field] && newLocation[field] !== existingLocation[field];
  return simpleFields.some(hasUpdatedSimpleField) || !isEqual(existingLocation.structured, newLocation.structured);
};

const mustUpdateNames = (fromAccount, fromAccountInfo) => {
  return (!fromAccount.name && fromAccountInfo?.name) || (!fromAccount.legalName && fromAccountInfo?.legalName);
};

/**
 * Checks that the profile has all requirements for this contribution (name, address, etc) and updates
 * it if necessary. Must be called **after** checking permissions and authentication!
 */
const checkAndUpdateProfileInfo = async (order, fromAccount, isGuest, currency) => {
  const { totalAmount, fromAccountInfo, guestInfo } = order;
  const accountUpdatePayload = {};
  const location = fromAccountInfo?.location || guestInfo?.location || fromAccount.location;
  const isContributingFromSameHost = fromAccount.HostCollectiveId === order.collective.HostCollectiveId;

  // Only enforce profile checks for guests and USD contributions at the moment
  if (isGuest && currency === 'USD' && !isContributingFromSameHost) {
    // Contributions that are more than $5000 must have an address attached
    if (totalAmount > 5000e2) {
      if (!location.structured && (!location.address || !location.country)) {
        throw new BadRequest('Contributions that are more than $5000 must have an address attached');
      }
    }

    // Contributions that are more than $250 must have a name attached
    if (totalAmount > 250e2) {
      const name = fromAccountInfo?.name || fromAccountInfo?.legalName || fromAccount.name || fromAccount.legalName;
      if (!name) {
        throw new BadRequest('Contributions that are more than $250 must have a name attached');
      }
    }
  }

  // Update account with new info, unless we're making a guest contribution for an existing account
  // (we don't want to let guests update the profile of an existing account that they may not own)
  const isVerifiedProfile = !fromAccount.data?.isGuest;
  if (!isGuest || !isVerifiedProfile) {
    if (mustUpdateLocation(fromAccount.location, location)) {
      accountUpdatePayload.data = { ...fromAccount.data, address: location.structured || fromAccount.data?.structured };
      accountUpdatePayload.locationName = location.name || fromAccount.locationName;
      accountUpdatePayload.address = location.address || fromAccount.address;
      accountUpdatePayload.countryISO = location.country || fromAccount.countryISO;
    }
    if (mustUpdateNames(fromAccount, fromAccountInfo)) {
      accountUpdatePayload.name = fromAccountInfo.name || fromAccountInfo.name;
      accountUpdatePayload.legalName = fromAccountInfo.legalName || fromAccountInfo.legalName;
    }
    if (!isEmpty(accountUpdatePayload)) {
      await fromAccount.update(accountUpdatePayload);
    }
  }
};

async function checkCaptcha(order, remoteUser, reqIp) {
  const requestedProvider = order.guestInfo?.captcha?.provider;
  const isCaptchaEnabled = parseToBoolean(config.captcha?.enabled);
  const isCreditCardOrder = order.paymentMethod?.type === PAYMENT_METHOD_TYPE.CREDITCARD;

  // We're just enforcing Captcha if it's enabled and if the order is using Credit Card
  if (!isCaptchaEnabled || !isCreditCardOrder) {
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
    logger.warn('Captcha verification failed:', response);
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
      const vatType =
        get(collective, 'settings.VAT.type') ||
        get(collective.parentCollective, 'settings.VAT.type') ||
        VAT_OPTIONS.HOST;

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
      id: LibTaxes.TaxType.GST,
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
        paymentMethod.type === 'crypto' ||
        paymentMethod.type === PAYMENT_METHOD_TYPE.PAYMENT_INTENT ||
        paymentMethod.type === PAYMENT_METHOD_TYPE.US_BANK_ACCOUNT ||
        paymentMethod.type === PAYMENT_METHOD_TYPE.SEPA_DEBIT,
    );
  }
};

export async function createOrder(order, req) {
  debug('Beginning creation of order', order);
  const { loaders, ip: reqIp, mask: reqMask } = req;
  const userAgent = req.header('user-agent');
  let remoteUser = req.remoteUser;

  if (remoteUser && !canUseFeature(remoteUser, FEATURE.ORDER)) {
    throw new FeatureNotAllowedForUser();
  } else if (!remoteUser) {
    await checkGuestContribution(order, loaders);
  }

  await checkOrdersLimit(order, reqIp, reqMask);
  await orderFraudProtection(req, order).catch(error => {
    reportErrorToSentry(error, { transactionName: 'orderFraudProtection', user: req.remoteUser });
    throw new ValidationFailed(
      "There's something wrong with the payment, please contact support@opencollective.com.",
      undefined,
      { includeId: true },
    );
  });

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
      const repositoryUrl = github.getGithubUrlFromHandle(order.collective.githubHandle);
      if (!repositoryUrl) {
        throw new Error('Invalid GitHub handle');
      }

      collective = await models.Collective.findOne({ where: { repositoryUrl } });
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

    const paymentRequired = (order.totalAmount > 0 || tier?.requiresPayment()) && collective.isActive;
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

      // Check if the Collective paying for the order is not blocked/frozen
      if (!canUseFeature(fromCollective, FEATURE.ORDER)) {
        throw new FeatureNotSupportedForCollective();
      }

      // We only allow to add funds on behalf of a collective if the user is an admin of that collective or an admin of the host of the collective that receives the money
      if (remoteUser?.isAdminOfCollective(fromCollective)) {
        await twoFactorAuthLib.enforceForAccountAdmins(req, fromCollective, { onlyAskOnLogin: true });
      } else if (remoteUser?.isAdminOfCollective(host)) {
        await twoFactorAuthLib.enforceForAccountAdmins(req, host, { onlyAskOnLogin: true });
      } else {
        throw new Error(
          `You don't have sufficient permissions to create an order on behalf of the ${
            fromCollective.name
          } ${fromCollective.type.toLowerCase()}`,
        );
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
        if (!canUseFeature(guestProfile.user, FEATURE.ORDER)) {
          throw new FeatureNotAllowedForUser();
        }

        remoteUser = guestProfile.user;
        fromCollective = guestProfile.collective;
        isGuest = true;
        guestToken = crypto.randomBytes(48).toString('hex');
      }
    }

    // Update the contributing profile with legal name / location
    await checkAndUpdateProfileInfo(order, fromCollective, isGuest);

    // Check currency
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

      const tipAmount = order.platformTipAmount || 0;
      const netAmountForCollective = order.totalAmount - order.taxAmount - (order.platformFee || 0) - tipAmount;
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

    const platformTipEligible = await libPayments.isPlatformTipEligible({ ...order, collective }, host);

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
      platformTipAmount: order.platformTipAmount,
      platformTipEligible,
      data: {
        ...orderPublicData,
        reqIp,
        reqMask,
        captchaResponse,
        tax: taxInfo,
        customData: order.customData,
        savePaymentMethod: Boolean(!isGuest && order.paymentMethod?.save),
        guestToken, // For guest contributions, this token is a way to authenticate to confirm the order
        isEmbed: Boolean(order.context?.isEmbed),
        isGuest,
        isBalanceTransfer: order.isBalanceTransfer,
        fromAccountInfo: order.fromAccountInfo,
        paymentIntent: order.paymentMethod?.paymentIntentId ? { id: order.paymentMethod.paymentIntentId } : undefined,
      },
      status: orderStatus,
    };

    // Handle specific fees
    // we use data instead of a column for now because it's an edge/experimental case
    // should be moved to a column if it starts to be widely used
    if (!isNil(order.hostFeePercent)) {
      orderData.data.hostFeePercent = order.hostFeePercent;
    } else if (!isNil(tier?.data?.hostFeePercent)) {
      orderData.data.hostFeePercent = tier.data.hostFeePercent;
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
      if (order.paymentMethod.type === 'paymentintent') {
        await orderCreated.reload();
        return { order: orderCreated };
      }
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
      await collective.addUserWithRole(remoteUser, roles.ATTENDEE, { TierId: tier?.id }, { order: orderCreated });
      await models.Activity.create({
        type: activities.TICKET_CONFIRMED,
        CollectiveId: collective.id,
        FromCollectiveId: fromCollective.id,
        HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
        UserId: remoteUser.id,
        UserTokenId: req.userToken?.id,
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

  if (order.status === status.PAID || order.status === status.ACTIVE) {
    throw new Error('This contribution has already been confirmed.');
  } else if (![status.ERROR, status.PENDING, status.REQUIRE_CLIENT_CONFIRMATION].includes(order.status)) {
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
      order.data = omit(order.data, ['error', 'latestError', 'paymentIntent', 'needsConfirmation']);
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
    include: [
      models.Order,
      models.PaymentMethod,
      { association: 'collective', required: false },
      { association: 'fromCollective', required: false },
    ],
  });

  if (!transaction) {
    throw new NotFound('Transaction not found');
  }

  // 1a. Verify user permission using canRefund. User must be either
  //   a. Admin of the collective that received the donation
  //   b. Admin of the Host Collective that received the donation
  //   c. Admin of opencollective.com/opencollective
  // 1b. Check transaction age - only Host admins can refund transactions older than 30 days
  // 1c. The transaction type must be CREDIT to prevent users from refunding their own DEBITs

  const canUserRefund = await canRefund(transaction, undefined, req);
  if (!canUserRefund) {
    throw new Forbidden('Cannot refund this transaction');
  }

  // Check 2FA
  const collective = transaction.type === 'CREDIT' ? transaction.collective : transaction.fromCollective;
  if (collective && req.remoteUser.isAdminOfCollective(collective)) {
    await twoFactorAuthLib.enforceForAccountAdmins(req, collective);
  } else {
    const creditTransaction = transaction.type === 'CREDIT' ? transaction : await transaction.getOppositeTransaction();
    if (req.remoteUser.isAdmin(creditTransaction?.HostCollectiveId)) {
      await twoFactorAuthLib.enforceForAccountAdmins(req, await creditTransaction.getHostCollective());
    }
  }

  // 2. Refund via payment method
  // 3. Create new transactions with the refund value in our database
  const result = await libPayments.refundTransaction(transaction, req.remoteUser, args.message);

  // Return the transaction passed to the `refundTransaction` method
  // after it was updated.
  return result;
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

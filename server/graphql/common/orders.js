import { isNil } from 'lodash';

import status from '../../constants/order_status';
import logger from '../../lib/logger';
import * as libPayments from '../../lib/payments';
import models from '../../models';

export async function addFunds(order, remoteUser) {
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

  if (order.tier && order.tier.CollectiveId !== order.collective.id) {
    throw new Error(`Tier #${order.tier.id} is not part of collective #${order.collective.id}`);
  }

  const orderData = {
    CreatedByUserId: remoteUser.id || user.id,
    FromCollectiveId: fromCollective.id,
    CollectiveId: collective.id,
    totalAmount: order.totalAmount,
    currency: collective.currency,
    description: order.description,
    status: status.NEW,
    TierId: order.tier?.id || null,
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

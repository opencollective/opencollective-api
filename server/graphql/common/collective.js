import config from 'config';
import sanitize from 'sanitize-html';

import activities from '../../constants/activities';
import FEATURE from '../../constants/feature';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../lib/rate-limit';
import { canUseFeature } from '../../lib/user-permissions';
import models from '../../models';
import { FeatureNotAllowedForUser, NotFound, RateLimitExceeded, Unauthorized } from '../errors';

import { checkRemoteUserCanUseAccount } from './scope-check';

/**
 * Resolver function for host field on Collective type.
 */

async function hostResolver(collective, _, { loaders }) {
  let hostCollective = null;
  if (collective.HostCollectiveId) {
    hostCollective = await loaders.Collective.byId.load(collective.HostCollectiveId);
    // Get the host collective from the parent collective.
  } else if (collective.ParentCollectiveId) {
    const parentCollective = await loaders.Collective.byId.load(collective.ParentCollectiveId);
    if (parentCollective && parentCollective.HostCollectiveId) {
      hostCollective = await loaders.Collective.byId.load(parentCollective.HostCollectiveId);
    }
  }
  return hostCollective;
}

async function sendMessage({ req, collective, args, isGqlV2 }) {
  checkRemoteUserCanUseAccount(req);
  const user = req.remoteUser;

  if (!canUseFeature(user, FEATURE.CONTACT_COLLECTIVE)) {
    throw new FeatureNotAllowedForUser(
      'You are not authorized to contact Collectives. Please contact support@opencollective.com if you think this is an error.',
    );
  }

  if (!collective) {
    throw new NotFound(`${isGqlV2 ? 'Account' : 'Collective'} not found`);
  }

  if (!(await collective.canContact())) {
    throw new Unauthorized(`You can't contact this ${isGqlV2 ? 'account' : 'collective'}`);
  }

  const message = args.message && sanitize(args.message, { allowedTags: [], allowedAttributes: {} }).trim();
  if (!message || message.length < 10) {
    throw new Error('Message is too short');
  }

  const subject =
    args.subject && sanitize(args.subject, { allowedTags: [], allowedAttributes: {} }).trim().slice(0, 60);

  // User sending the email must have an associated collective
  const fromCollective = await req.loaders.Collective.byId.load(user.CollectiveId);
  if (!fromCollective) {
    throw new Error("Your user account doesn't have any profile associated. Please contact support");
  }

  // Limit email sent per user
  if (!user.isAdminOfCollectiveOrHost(collective) && !user.isRoot()) {
    const maxEmailMessagePerHour = config.limits.collectiveEmailMessagePerHour;
    const cacheKey = `user_contact_send_message_${user.id}`;
    const rateLimit = new RateLimit(cacheKey, maxEmailMessagePerHour, ONE_HOUR_IN_SECONDS);
    if (!(await rateLimit.registerCall())) {
      throw new RateLimitExceeded('Too many messages sent in a limited time frame. Please try again later.');
    }
  }

  // Create the activity (which will send the message to the users)
  await models.Activity.create({
    type: activities.COLLECTIVE_CONTACT,
    UserId: user.id,
    UserTokenId: req.userToken?.id,
    CollectiveId: collective.id,
    FromCollectiveId: user.CollectiveId,
    HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
    data: {
      fromCollective,
      collective,
      user,
      subject: subject || null,
      message: message,
    },
  });

  return { success: true };
}

export { hostResolver, sendMessage };

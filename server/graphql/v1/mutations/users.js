import crypto from 'crypto';

import config from 'config';

import { activities } from '../../../constants/index.js';
import cache from '../../../lib/cache/index.js';
import emailLib from '../../../lib/email.js';
import models from '../../../models/index.js';
import { InvalidToken, RateLimitExceeded, Unauthorized, ValidationFailed } from '../../errors.js';

const oneHourInSeconds = 60 * 60;

/**
 * Sets `emailWaitingForValidation` to `newEmail` for `user` and sends a confirmation
 * email for users to confirm their email addresses.
 */
export const updateUserEmail = async (user, newEmail) => {
  if (!user) {
    throw new Unauthorized();
  } else if (!user.confirmedAt) {
    throw new Error('You need to verify your account before changing your email address');
  }

  // Put some rate limiting for user so they can't bruteforce the system to guess emails
  const maxChangePerHour = config.limits.changeEmailPerHour.update;
  const countCacheKey = `user_email_change_${user.id}`;
  const existingCount = (await cache.get(countCacheKey)) || 0;
  if (existingCount > maxChangePerHour) {
    throw new RateLimitExceeded();
  }

  // If somehow user tries to update the email to its existing value then we remove
  // any email waiting for confirmation
  if (user.email === newEmail) {
    if (user.emailWaitingForValidation !== null) {
      return user.update({ emailWaitingForValidation: null, emailConfirmationToken: null });
    }
    return user;
  }

  // Ensure this email is not already used by another user
  const existingEmail = await models.User.findOne({ where: { email: newEmail } });
  if (existingEmail) {
    throw new ValidationFailed('A user with that email already exists');
  }

  // If user tries to update again with the same email, we send the email without
  // re-generating the token.
  if (newEmail !== user.emailWaitingForValidation) {
    // Store temporary user's email and generate the confirmation token
    user = await user.update({
      emailWaitingForValidation: newEmail,
      emailConfirmationToken: crypto.randomBytes(48).toString('hex'),
    });
  }

  const data = {
    user: {
      ...user.info,
      emailConfirmationToken: user.emailConfirmationToken,
      emailWaitingForValidation: user.emailWaitingForValidation,
    },
  };

  // Send the email and return updated user
  await emailLib.send(activities.USER_CHANGE_EMAIL, data.user.emailWaitingForValidation, data, {
    sendEvenIfNotProduction: true,
  });
  await models.Activity.create({
    type: activities.USER_CHANGE_EMAIL,
    UserId: user.id,
    CollectiveId: user.CollectiveId,
    FromCollectiveId: user.CollectiveId,
    data: { notify: false },
  });

  // Update the cache
  cache.set(countCacheKey, existingCount + 1, oneHourInSeconds);

  return user;
};

/**
 * From a given token (generated in `updateUserEmail`) confirm the new email
 * and updates the user record.
 */
export const confirmUserEmail = async emailConfirmationToken => {
  if (!emailConfirmationToken) {
    throw new ValidationFailed('Email confirmation token must be set');
  }

  const user = await models.User.findOne({ where: { emailConfirmationToken } });

  if (!user) {
    throw new InvalidToken('Invalid email confirmation token', 'INVALID_TOKEN', {
      internalData: { emailConfirmationToken },
    });
  }

  return user.update({
    email: user.emailWaitingForValidation,
    emailWaitingForValidation: null,
    emailConfirmationToken: null,
  });
};

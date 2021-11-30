import crypto from 'crypto';

import { isEmpty } from 'lodash';
import { v4 as uuid } from 'uuid';

import { types as COLLECTIVE_TYPE } from '../constants/collectives';
import { BadRequest, InvalidToken, NotFound } from '../graphql/errors';
import models, { sequelize } from '../models';

export const DEFAULT_GUEST_NAME = 'Guest';

type GuestProfileDetails = {
  user: typeof models.User;
  collective: typeof models.Collective;
};

type Location = {
  country?: string | null;
  address?: string | null;
  structured?: Record<string, string> | null;
};

/**
 * If more recent info on the collective has been provided, update it. Otherwise do nothing.
 */
const updateCollective = async (collective, newInfo, transaction) => {
  const fieldsToUpdate = {};

  if (newInfo.name && collective.name !== newInfo.name) {
    fieldsToUpdate['name'] = newInfo.name;
  }

  if (newInfo.location) {
    if (newInfo.location.country && newInfo.location.country !== collective.countryISO) {
      fieldsToUpdate['countryISO'] = newInfo.location.country;
    }
    if (newInfo.location.address && newInfo.location.address !== collective.address) {
      fieldsToUpdate['address'] = newInfo.location.address;
    }
    if (newInfo.location.structured) {
      fieldsToUpdate['data'] = { ...(collective.data || {}), address: newInfo.location.structured };
    }
  }

  return isEmpty(fieldsToUpdate) ? collective : collective.update(fieldsToUpdate, { transaction });
};

type UserInfoInput = {
  email?: string | null;
  name?: string | null;
  legalName?: string | null;
  location?: Location;
};

type UserCreationRequest = {
  ip: string;
  userAgent: string;
};

/**
 * Retrieves or create an guest profile by email.
 */
export const getOrCreateGuestProfile = async (
  { email, name, legalName, location }: UserInfoInput,
  creationRequest: UserCreationRequest = null,
): Promise<GuestProfileDetails> => {
  const emailConfirmationToken = crypto.randomBytes(48).toString('hex');

  if (!email) {
    throw new Error('An email is required to create a guest profile');
  }

  return sequelize.transaction(async transaction => {
    // Create (or fetch) the user associated with the email
    let user, collective;
    user = await models.User.findOne({ where: { email } }, { transaction });
    if (!user) {
      user = await models.User.create(
        {
          email,
          confirmedAt: null,
          emailConfirmationToken,
          data: {
            creationRequest,
          },
        },
        { transaction },
      );
    } else if (user.CollectiveId) {
      collective = await models.Collective.findByPk(user.CollectiveId, { transaction });
      if (!user.confirmedAt) {
        const newLegalName = legalName || collective.legalName;
        const newValues = { name, location, legalName: newLegalName };
        collective = await updateCollective(collective, newValues, transaction);
      }
    }

    // Create the public guest profile
    if (!collective) {
      collective = await models.Collective.create(
        {
          type: COLLECTIVE_TYPE.USER,
          slug: `guest-${uuid().split('-')[0]}`,
          name: name || DEFAULT_GUEST_NAME,
          legalName,
          data: { isGuest: true, address: location?.structured },
          address: location?.address,
          countryISO: location?.country,
          CreatedByUserId: user.id,
        },
        { transaction },
      );
    }

    if (!user.CollectiveId) {
      await user.update({ CollectiveId: collective.id }, { transaction });
    }

    return { collective, user };
  });
};

/**
 * Mark a guest account as "confirmed"
 */
export const confirmGuestAccount = async (
  user: typeof models.User,
): Promise<{
  collective: typeof models.Collective;
  user: typeof models.User;
}> => {
  // 1. Mark user as confirmed
  await user.update({ emailConfirmationToken: null, confirmedAt: new Date() });

  // 2. Update the profile (collective)
  let userCollective = await user.getCollective();
  const newName = userCollective.name !== DEFAULT_GUEST_NAME ? userCollective.name : 'Incognito';
  userCollective = await userCollective.update({
    name: newName,
    data: { ...userCollective.data, isGuest: false, wasGuest: true },
  });

  return { user, collective: userCollective };
};

/**
 * Mark a guest account as "confirmed" if the provided `emailConfirmationToken` is valid
 */
export const confirmGuestAccountByEmail = async (
  email: string,
  emailConfirmationToken: string,
): Promise<{
  collective: typeof models.Collective;
  user: typeof models.User;
}> => {
  const user = await models.User.findOne({ where: { email } });
  if (!user) {
    throw new NotFound(`No account found for ${email}`, null, { internalData: { emailConfirmationToken } });
  } else if (user.confirmedAt) {
    // `emailConfirmationToken` is also used when users change their emails. If the account if already confirmed,
    // there's no reason to go through this function even if the token is valid.
    throw new BadRequest('This account has already been verified', 'ACCOUNT_ALREADY_VERIFIED');
  } else if (!user.emailConfirmationToken || user.emailConfirmationToken !== emailConfirmationToken) {
    throw new InvalidToken('Invalid email confirmation token', 'INVALID_TOKEN', {
      internalData: { emailConfirmationToken },
    });
  }

  return confirmGuestAccount(user);
};

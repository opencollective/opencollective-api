import crypto from 'crypto';

import { isEmpty } from 'lodash';
import { v4 as uuid } from 'uuid';

import { types as COLLECTIVE_TYPE } from '../constants/collectives';
import { BadRequest, InvalidToken, NotFound, Unauthorized } from '../graphql/errors';
import models, { Op, sequelize } from '../models';

import { mergeCollectives } from './collectivelib';

export const DEFAULT_GUEST_NAME = 'Guest';
const INVALID_TOKEN_MSG = 'Your guest token is invalid. If you already have an account, please sign in.';

type GuestProfileDetails = {
  user: typeof models.User;
  collective: typeof models.Collective;
  token: typeof models.GuestToken;
};

type Location = {
  country: string | null;
  address: string | null;
};

/**
 * Load a `GuestToken` from its code, returns the user and collective associated
 */
export const loadGuestToken = async (guestToken: string): Promise<GuestProfileDetails> => {
  const token = await models.GuestToken.findOne({
    where: { value: guestToken },
    include: [{ association: 'collective', required: true }],
  });

  if (!token) {
    throw new Error(INVALID_TOKEN_MSG);
  }

  const user = await models.User.findOne({ where: { CollectiveId: token.collective.id } });
  if (!user) {
    // This can happen if trying to contribute with a guest token when the user
    // associated has been removed (ie. if it's a spammer)
    throw new Error(INVALID_TOKEN_MSG);
  }

  return { token, collective: token.collective, user };
};

const createGuestProfile = (
  email: string,
  name: string | null,
  location: Location | null,
): Promise<GuestProfileDetails> => {
  const emailConfirmationToken = crypto.randomBytes(48).toString('hex');
  const guestToken = crypto.randomBytes(48).toString('hex');

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
        },
        { transaction },
      );
    } else if (user.confirmedAt) {
      // We only allow to re-use the same User without token if it's not verified.
      throw new Unauthorized(
        'An account already exists for this email, please sign in.',
        'ACCOUNT_EMAIL_ALREADY_EXISTS',
      );
    } else if (user.CollectiveId) {
      collective = await models.Collective.findByPk(user.CollectiveId, { transaction });
    }

    // Create the public guest profile
    if (!collective) {
      collective = await models.Collective.create(
        {
          type: COLLECTIVE_TYPE.USER,
          slug: `guest-${uuid().split('-')[0]}`,
          name: name || DEFAULT_GUEST_NAME,
          data: { isGuest: true },
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

    // Create the token that will be used to authenticate future contributions for
    // this guest profile
    const guestTokenData = { CollectiveId: collective.id, UserId: user.id, value: guestToken };
    const token = await models.GuestToken.create(guestTokenData, { transaction });

    return { collective, user, token };
  });
};

/**
 * If more recent info on the collective has been provided, update it. Otherwise do nothing.
 */
const updateCollective = async (collective, name: string, location: Location) => {
  const fieldsToUpdate = {};

  if (name && collective.name !== name) {
    fieldsToUpdate['name'] = name;
  }

  if (location) {
    if (location.country && location.country !== collective.countryISO) {
      fieldsToUpdate['countryISO'] = location.country;
    }
    if (location.address && location.address !== collective.address) {
      fieldsToUpdate['address'] = location.address;
    }
  }

  return isEmpty(fieldsToUpdate) ? collective : collective.update(fieldsToUpdate);
};

/**
 * Returns the guest profile from a guest token
 */
const getGuestProfileFromToken = async (tokenValue, { email, name, location }): Promise<GuestProfileDetails> => {
  const { collective, user, token } = await loadGuestToken(tokenValue);

  if (user.confirmedAt) {
    // Account exists & user is confirmed => need to sign in
    throw new Unauthorized('An account already exists for this email, please sign in.', 'ACCOUNT_EMAIL_ALREADY_EXISTS');
  } else if (email && user.email !== email.trim()) {
    // The user is making a new guest contribution from the same browser but with
    // a different email. For now the behavior is to ignore the existing guest profile
    // and to create a new one.
    return createGuestProfile(email, name, location);
  } else {
    // Contributing again as guest using the same guest token, update profile info if needed
    return {
      collective: await updateCollective(collective, name, location),
      user,
      token,
    };
  }
};

/**
 * Retrieves or create an guest profile.
 */
export const getOrCreateGuestProfile = async ({
  email,
  token,
  name,
  location,
}: {
  email?: string | null;
  token?: string | null;
  name?: string | null;
  location?: Location;
}): Promise<GuestProfileDetails> => {
  if (token) {
    // If there is a guest token, we try to fetch the profile from there
    return getGuestProfileFromToken(token, { email, name, location });
  } else {
    // First time contributing as a guest or re-using an existing email with a different
    // token. Note that a new Collective profile will be created for the contribution if the guest
    // token don't match.
    return createGuestProfile(email, name, location);
  }
};

export const confirmGuestAccount = async (
  user: typeof models.User,
  guestTokensValues?: string[] | null,
): Promise<{
  collective: typeof models.Collective;
  user: typeof models.User;
}> => {
  // 1. Mark user as confirmed
  await user.update({ emailConfirmationToken: null, confirmedAt: new Date() });

  // 2. Update the profile (collective)
  const userCollective = await user.getCollective();
  const newName = userCollective.name !== DEFAULT_GUEST_NAME ? userCollective.name : 'Incognito';
  await userCollective.update({
    name: newName,
    slug: newName === 'Incognito' ? `user-${uuid().split('-')[0]}` : await models.Collective.generateSlug([newName]),
    data: { ...userCollective.data, isGuest: false, wasGuest: true },
  });

  // 3. Link the other guest profiles & contributions
  await linkOtherGuestProfiles(user, userCollective, guestTokensValues);

  // 4. If name was updated by the merge, update the slug
  await userCollective.reload();
  if (newName !== userCollective.name && userCollective.slug.startsWith('user-')) {
    await userCollective.update({
      slug: await models.Collective.generateSlug([userCollective.name]),
    });
  }

  return { user, collective: userCollective };
};

export const confirmGuestAccountByEmail = async (
  email: string,
  emailConfirmationToken: string,
  guestTokensValues?: string[] | null,
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

  return confirmGuestAccount(user, guestTokensValues);
};

const linkOtherGuestProfiles = async (user, userCollective, guestTokensValues) => {
  const guestTokensConditions: Record<string, unknown>[] = [
    // User owns the email, so we can safely link all the contributions made with it
    { UserId: user.id },
    // User main profile
    { CollectiveId: userCollective.id },
  ];

  if (guestTokensValues?.length) {
    // If users have some guest tokens, not matter what the profiles are, it means they are the ones
    // who made the contributions for the profiles so we can safely link them
    guestTokensConditions.push({ value: { [Op.in]: guestTokensValues } });
  }

  const guestTokens = await models.GuestToken.findAll({
    where: { [Op.or]: guestTokensConditions },
    include: [
      {
        association: 'collective',
        required: true,
      },
    ],
  });

  if (guestTokens.length > 0) {
    await Promise.all(
      guestTokens
        .filter(token => token.collective.id !== userCollective.id && token.collective.data.isGuest)
        .map(token => mergeCollectives(token.collective, userCollective)),
    );

    // Delete all guest tokens
    await models.GuestToken.destroy({
      where: { id: { [Op.in]: guestTokens.map(token => token.id) } },
    });
  }
};

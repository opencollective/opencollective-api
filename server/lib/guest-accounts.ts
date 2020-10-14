import crypto from 'crypto';

import { v4 as uuid } from 'uuid';

import { types as COLLECTIVE_TYPE } from '../constants/collectives';
import models, { sequelize } from '../models';

const INVALID_TOKEN_MSG = 'Your guest token is invalid. If you already have an account, please sign in.';

type GuestProfileDetails = {
  user: typeof models.User;
  collective: typeof models.Collective;
  token: typeof models.GuestToken;
};

/**
 * Load a `GuestToken` from its code, returns the user and collective associated
 */
const loadGuestToken = async (guestToken: string): Promise<GuestProfileDetails> => {
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

const createGuestProfile = (email: string, name: string | null): Promise<GuestProfileDetails> => {
  const emailConfirmationToken = crypto.randomBytes(48).toString('hex');
  const guestToken = crypto.randomBytes(48).toString('hex');

  if (!email) {
    throw new Error('An email is required to create a guest profile');
  }

  return sequelize.transaction(async transaction => {
    // Create the public guest profile
    const collective = await models.Collective.create(
      {
        type: COLLECTIVE_TYPE.USER,
        slug: `guest-${uuid().split('-')[0]}`,
        name: name ?? 'Guest',
        data: { isGuest: true },
      },
      { transaction },
    );

    // Create (or fetch) the user associated with the email
    let user = await models.User.findOne({ where: { email } }, { transaction });
    if (!user) {
      user = await models.User.create(
        {
          email,
          confirmedAt: null,
          CollectiveId: collective.id,
          emailConfirmationToken,
        },
        { transaction },
      );
    } else if (user.confirmedAt) {
      // We only allow to re-use the same User without token if it's not verified.
      throw new Error('An account already exists for this email, please sign in.');
    }

    await collective.update({ CreatedByUserId: user.id }, { transaction });

    // Create the token that will be used to authenticate future contributions for
    // this guest profile
    const guestTokenData = { CollectiveId: collective.id, value: guestToken };
    const token = await models.GuestToken.create(guestTokenData, { transaction });

    return { collective, user, token };
  });
};

/**
 * Returns the guest profile from a guest token
 */
const getGuestProfileFromToken = async (token, { email, name }): Promise<GuestProfileDetails> => {
  const { collective, user } = await loadGuestToken(token);

  if (user.confirmedAt) {
    // Account exists & user is confirmed => need to sign in
    throw new Error('An account already exists for this email, please sign in.');
  } else if (email && user.email !== email.trim()) {
    // The user is making a new guest contribution from the same browser but with
    // a different email. For now the behavior is to ignore the existing guest profile
    // and to create a new one.
    return createGuestProfile(email, name);
  } else {
    // Contributing again as guest using the same guest token
    return { collective, user, token };
  }
};

/**
 * Retrieves or create an guest profile.
 */
export const getOrCreateGuestProfile = async ({
  email,
  token,
  name,
}: {
  email?: string | null;
  token?: string | null;
  name?: string | null;
}): Promise<GuestProfileDetails> => {
  if (token) {
    // If there is a guest token, we try to fetch the profile from there
    return getGuestProfileFromToken(token, { email, name });
  } else {
    // First time contributing as a guest or re-using an existing email with a different
    // token. Note that a new Collective profile will be created for the contribution if the guest
    // token don't match.
    return createGuestProfile(email, name);
  }
};

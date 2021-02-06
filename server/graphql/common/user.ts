import config from 'config';
import { pick } from 'lodash';

import roles from '../../constants/roles';
import emailLib from '../../lib/email';
import logger from '../../lib/logger';
import models, { sequelize } from '../../models';
import { ValidationFailed } from '../errors';

type CreateUserOptions = {
  organizationData?: {
    name: string;
    slug: string;
    website?: string;
    twitterHandle?: string;
    githubHandle?: string;
  };
  sendSignInLink?: boolean;
  throwIfExists?: boolean;
  redirect?: string;
  websiteUrl?: string;
  creationRequest?: {
    ip: any;
    userAgent: any;
  };
};

export const createUser = (
  userData: { firstName: string; lastName: string; email: string; newsletterOptIn: boolean },
  { organizationData, sendSignInLink, throwIfExists, redirect, websiteUrl, creationRequest }: CreateUserOptions,
): Promise<{ user: any; organization?: any }> => {
  return sequelize.transaction(async transaction => {
    let user = await models.User.findOne({ where: { email: userData.email.toLowerCase() } }, { transaction });

    if (throwIfExists && user) {
      throw new ValidationFailed('It looks like that email already exists, please sign in instead');
    } else if (!user) {
      // Create user
      user = await models.User.createUserWithCollective(userData, transaction);
      user = await user.update({ data: { creationRequest } }, { transaction });
    }

    let organization;
    // Create organization
    if (organizationData) {
      const organizationParams = {
        type: 'ORGANIZATION',
        CreatedByUserId: user.id,
        ...pick(organizationData, ['name', 'slug', 'description', 'website', 'twitterHandle', 'githubHandle']),
      };
      organization = await models.Collective.create(organizationParams, { transaction });
      await organization.addUserWithRole(user, roles.ADMIN, { CreatedByUserId: user.id }, {}, transaction);
    }

    // Sent signIn link
    if (sendSignInLink) {
      const loginLink = user.generateLoginLink(redirect, websiteUrl);
      if (config.env === 'development') {
        logger.info(`Login Link: ${loginLink}`);
      }
      emailLib.send('user.new.token', user.email, { loginLink }, { sendEvenIfNotProduction: true });
    }

    return { user, organization };
  });
};

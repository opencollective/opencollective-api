import config from 'config';

import * as auth from '../lib/auth';
import emailLib from '../lib/email';
import blockstackLib from '../lib/blockstack';
import models from '../models';
import logger from '../lib/logger';
import { isValidEmail } from '../lib/utils';

/**
 *
 * Public methods.
 *
 */

/**
 * Check existence of a user based on email
 */
export const exists = async (req, res) => {
  const email = req.query.email.toLowerCase();
  if (!isValidEmail(email)) {
    return res.send({ exists: false });
  } else {
    const user = await models.User.findOne({
      attributes: ['id'],
      where: { email },
    });
    return res.send({ exists: Boolean(user) });
  }
};

/**
 * Check existence of a user based on email and publicKey
 */
export const existsWithPublicKey = async (req, res) => {
  const email = req.query.email.toLowerCase();
  if (!isValidEmail(email)) {
    return res.send({ exists: false });
  } else {
    const publicKey = req.query.publicKey;
    if (publicKey) {
      const user = await models.User.findOne({
        attributes: ['id', 'email'],
        where: { publicKey },
      });
      const exists = user && user.email === email;
      return res.send({ exists: Boolean(exists) });
    } else {
      const user = await models.User.findOne({
        attributes: ['id'],
        where: { email },
      });
      return res.send({ exists: Boolean(user) });
    }
  }
};

/**
 * Login or create a new user
 */
export const signin = (req, res, next) => {
  const { user, redirect, websiteUrl } = req.body;
  let loginLink;
  return models.User.findOne({ where: { email: user.email.toLowerCase() } })
    .then(u => u || models.User.createUserWithCollective(user))
    .then(u => {
      loginLink = u.generateLoginLink(redirect || '/', websiteUrl);
      if (config.env === 'development') {
        logger.info(`Login Link: ${loginLink}`);
      }
      return emailLib.send('user.new.token', u.email, { loginLink }, { sendEvenIfNotProduction: true });
    })
    .then(() => {
      const response = { success: true };
      // For e2e testing, we enable testuser+(admin|member)@opencollective.com to automatically receive the login link
      if (process.env.NODE_ENV !== 'production' && user.email.match(/.*test.*@opencollective.com$/)) {
        response.redirect = loginLink;
      }
      return response;
    })
    .then(response => res.send(response))
    .catch(next);
};

export const signinPublicKey = (req, res, next) => {
  const { user, redirect, websiteUrl } = req.body;
  return blockstackLib
    .findOne(user)
    .then(u => u || models.User.createUserWithCollective(user))
    .then(u => {
      const loginLink = u.generateLoginLink(redirect || '/', websiteUrl);
      if (config.env === 'development') {
        logger.info(`Login Link: ${loginLink}`);
      }
      const response = { success: true };
      response.redirect = blockstackLib.encryptLink(user.publicKey, loginLink);
      return response;
    })
    .then(response => res.send(response))
    .catch(next);
};

/**
 * Receive a JWT and generate another one.
 *
 * This can be used right after the first login
 */
export const updateToken = async (req, res) => {
  const token = req.remoteUser.jwt({}, auth.TOKEN_EXPIRATION_SESSION);
  res.send({ token });
};

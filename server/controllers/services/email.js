import Promise from 'bluebird';
import debug from 'debug';
import { get } from 'lodash';

import emailLib from '../../lib/email';
import errors from '../../lib/errors';
import logger from '../../lib/logger';
import { reportErrorToSentry } from '../../lib/sentry';
import models from '../../models';

const debugEmail = debug('email');
const debugWebhook = debug('webhook');

export const unsubscribe = async (req, res, next) => {
  const { type, email, slug, token } = req.params;

  if (!emailLib.isValidUnsubscribeToken(token, email, slug, type)) {
    return next(new errors.BadRequest('Invalid token'));
  }

  try {
    const collective = await models.Collective.findOne({ where: { slug } });
    const user = await models.User.findOne({ where: { email } });
    if (!user) {
      throw new errors.NotFound(`Cannot find a user with email "${email}"`);
    }

    await models.Notification.unsubscribe(type, 'email', user.id, collective.id);
    res.send({ response: 'ok' });
  } catch (e) {
    next(e);
  }
};

// TODO: move to emailLib.js
const sendEmailToList = async (to, email) => {
  debugEmail('sendEmailToList', to, 'email data: ', email);

  const { mailinglist, collectiveSlug, type } = getNotificationType(to);
  email.from = email.from || `${collectiveSlug} collective <no-reply@${collectiveSlug}.opencollective.com>`;
  email.collective = email.collective || { slug: collectiveSlug }; // used for the unsubscribe url

  const subscribers = await models.Notification.getSubscribersUsers(collectiveSlug, mailinglist);
  if (subscribers.length === 0) {
    throw new errors.NotFound(`No subscribers found in ${collectiveSlug} for email type ${type}`);
  }

  const recipients = subscribers.map(r => r.email);

  debugEmail(`Sending email from ${email.from} to ${to} (${recipients.length} recipient(s))`);
  return Promise.map(recipients, recipient => {
    if (email.template) {
      return emailLib.send(email.template, to, email, {
        from: email.from,
        bcc: recipient,
        type,
      });
    } else {
      email.body += '\n<!-- OpenCollective.com -->\n'; // watermark to identify if email has already been processed
      return emailLib.sendMessage(to, email.subject, email.body, {
        from: email.from,
        bcc: recipient,
        type,
      });
    }
  });
};

export const getNotificationType = email => {
  debugEmail('getNotificationType', email);
  let tokens;
  if (email.match(/<.+@.+\..+>/)) {
    tokens = email.match(/<(.+)@(.+)\.opencollective\.com>/i);
  } else {
    tokens = email.match(/(.+)@(.+)\.opencollective\.com/i);
  }
  if (!tokens) {
    return {};
  }
  const collectiveSlug = tokens[2];
  let mailinglist = tokens[1];
  if (['info', 'hello', 'members', 'admins', 'admins'].indexOf(mailinglist) !== -1) {
    mailinglist = 'admins';
  }
  const type = `mailinglist.${mailinglist}`;
  const res = { collectiveSlug, mailinglist, type };
  debugEmail('getNotificationType', res);
  return res;
};

export const webhook = async (req, res, next) => {
  const email = req.body;
  const { recipient } = email;
  debugWebhook('>>> webhook received', JSON.stringify(email));
  const { mailinglist, collectiveSlug } = getNotificationType(recipient);

  if (!collectiveSlug) {
    return res.send(`Invalid recipient (${recipient}), skipping`);
  }

  debugWebhook(`email received for ${mailinglist} mailinglist of ${collectiveSlug}`);
  const body = email['body-html'] || email['body-plain'];

  // If receive an email that has already been processed, we skip it
  // (it happens since we send the approved email to the mailing list and add the recipients in /bcc)
  if (body.indexOf('<!-- OpenCollective.com -->') !== -1) {
    debugWebhook(`Email from ${email.from} with subject ${email.subject} already processed, skipping`);
    return res.send('Email already processed, skipping');
  }

  // If an email is sent to [info|hello|members|admins|organizers]@:collectiveSlug.opencollective.com,
  // we simply forward it to admins who subscribed to that mailinglist (no approval process)
  if (mailinglist === 'admins') {
    const collective = await models.Collective.findOne({ where: { slug: collectiveSlug } });
    if (!collective) {
      return res.send({
        error: { message: `This Collective doesn't exist or can't be emailed directly using this address` },
      });
    } else if (!get(collective.settings, 'features.forwardEmails') || !(await collective.canContact())) {
      return res.send({
        error: { message: `This Collective can't be emailed directly using this address` },
      });
    } else {
      return sendEmailToList(recipient, { subject: email.subject, body, from: email.from })
        .then(() => res.send('ok'))
        .catch(e => {
          logger.error(e);
          reportErrorToSentry(e);
          return next(new errors.ServerError('Unexpected error'));
        });
    }
  } else {
    debugWebhook('Mailing list not found');
    return res.send({
      error: {
        message: `Invalid mailing list address ${mailinglist}@${collectiveSlug}.opencollective.com`,
      },
    });
  }
};

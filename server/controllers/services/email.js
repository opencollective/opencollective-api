import prependHttp from 'prepend-http';
import sanitizeHtml from 'sanitize-html';

import { checkCaptcha } from '../../lib/check-captcha';
import emailLib from '../../lib/email';
import errors from '../../lib/errors';
import logger from '../../lib/logger';
import models from '../../models';

export const unsubscribe = async (req, res, next) => {
  const { email, slug, token } = req.params;
  let type = req.params.type;
  if (type === 'order.thankyou') {
    type = 'order.confirmed';
  }

  if (!emailLib.isValidUnsubscribeToken(token, email, slug, type)) {
    return next(new errors.BadRequest('Invalid token'));
  }

  try {
    const collective = await models.Collective.findOne({ where: { slug } });
    const user = await models.User.findOne({ where: { email } });
    if (!user) {
      throw new errors.NotFound(`Cannot find a user with email "${email}"`);
    }

    await models.Notification.unsubscribe(type, 'email', user.id, collective?.id);
    res.send({ response: 'ok' });
  } catch (e) {
    next(e);
  }
};

export const messageSupport = async (req, res) => {
  const body = req.body;

  if (!(body && body.name && body.email && body.message?.length)) {
    res.status(400).send('All inputs required');
  }
  const {
    ip,
    remoteUser,
    body: { captcha },
  } = req;

  if (!remoteUser) {
    await checkCaptcha(captcha, ip);
  }

  let additionalLink = '';
  if (body.link) {
    const bodyLink = prependHttp(body.link);
    additionalLink = `Additional Link: <a href="${bodyLink}">${bodyLink}</a></br>`;
  }

  let relatedCollectives = 'Related Collectives: ';
  if (body.relatedCollectives?.length > 0) {
    relatedCollectives = body.relatedCollectives
      .slice(0, 50)
      .map(url => `<a href='${url}'>${url}</a>`)
      .join(', ');
  }

  logger.info(`Contact Form: ${body.name} <${body.email}>`);
  logger.info(`Contact Subject: ${body.topic}`);
  logger.info(`Contact Message: ${body.message}`);
  if (body.relatedCollectives?.length > 0) {
    logger.info(`${relatedCollectives}`);
  }
  if (additionalLink) {
    logger.info(`Contact Link: ${additionalLink}`);
  }
  const recipient = 'support@opencollective.com';
  const options = { from: `${body.name} <${body.email}>` };
  const topic = `${body.topic}`;
  const rawHtml = `${body.message}
  <br/>
  ${body.relatedCollectives?.length > 0 ? relatedCollectives : ''}
  <br/>
  <br/>
  ${additionalLink}`;

  const html = sanitizeHtml(rawHtml, {
    allowedTags: ['a', 'br', 'strong', 'ul', 'li', 'ol'],
    allowedAttributes: {
      a: ['href'],
    },
  });

  await emailLib.sendMessage(recipient, topic, html, options);

  res.status(200).send({ sent: true });
};

import config from 'config';
import debugLib from 'debug';
import { htmlToText } from 'html-to-text';
import juice from 'juice';
import { get, includes, isArray, merge, pick } from 'lodash';
import nodemailer from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport';

import { activities } from '../constants';
import models from '../models';

import authorizedEmailDomains from './authorizedEmailDomains';
import templates, { EmailTemplates } from './emailTemplates';
import logger from './logger';
import { reportErrorToSentry } from './sentry';
import { isEmailInternal, md5, sha512 } from './utils';

const debug = debugLib('email');

type SendMessageOptions = Pick<
  nodemailer.SendMailOptions,
  'from' | 'cc' | 'to' | 'bcc' | 'subject' | 'text' | 'html' | 'headers' | 'attachments'
> & {
  tag?;
  replyTo?;
  attachments?;
  sendEvenIfNotProduction?: boolean;
  type?: EmailTemplates;
  isTransactional?: boolean;
  unsubscribeUrl?: string;
  accountSlug?: string;
  listId?: string;
};

type SendMessageData = {
  notificationTypeLabel?: string;
  unsubscribeUrl?: string;
  interval?: string;
  config?;
} & Record<string, any>;

export const getMailer = () => {
  if (config.maildev.client) {
    return nodemailer.createTransport({
      host: '127.0.0.1',
      ignoreTLS: true,
      port: 1025,
    });
  }
  if (get(config, 'mailgun.user') && get(config, 'mailgun.password')) {
    return nodemailer.createTransport({
      service: 'Mailgun',
      auth: {
        user: get(config, 'mailgun.user'),
        pass: get(config, 'mailgun.password'),
      },
    });
  }
};

const render = (template: EmailTemplates, data: any) => {
  data.imageNotSvg = data.collective && data.collective.image && !data.collective.image.endsWith('.svg');
  data = merge({}, data);
  delete data.config;
  data.config = { host: config.host };

  const html = juice(templates[template](data));
  const text = htmlToText(html);
  return { text, html };
};

const generateUnsubscribeToken = (email, collectiveSlug, type, hashingFunction = sha512) => {
  const uid = `${email}.${collectiveSlug || 'any'}.${type}.${config.keys.opencollective.emailUnsubscribeSecret}`;
  const token = hashingFunction(uid);
  return token;
};

const isValidUnsubscribeToken = (token, email, collectiveSlug, type) => {
  // Check token using the latest procedure
  const computedToken = emailLib.generateUnsubscribeToken(email, collectiveSlug, type, sha512);
  if (computedToken === token) {
    return true;
  }

  // Backward-compatibility: check legacy tokens
  return emailLib.generateUnsubscribeToken(email, collectiveSlug, type, md5) === token;
};

/*
 * Gets the body from a string (usually a template)
 */
const getTemplateAttributes = (str: string) => {
  let index = 0;
  const lines = str.split('\n');
  const attributes = { body: '', subject: '' };
  let tokens;
  do {
    tokens = lines[index++].match(/^([a-z]+):(.+)/i);
    if (tokens) {
      attributes[tokens[1].toLowerCase()] = tokens[2].replace(/<br( \/)?>/g, '\n').trim();
    }
  } while (tokens);

  attributes.body = lines.slice(index).join('\n').trim();
  return attributes;
};

const filterBccForTestEnv = emails => {
  if (!emails) {
    return emails;
  }

  const isString = typeof emails === 'string';
  const list = isString ? emails.split(',') : emails;
  const filtered = list.filter(isEmailInternal);
  return isString ? filtered.join(',') : filtered;
};

/*
 * sends an email message to a recipient with given subject and body
 */
const sendMessage = (
  recipients: string | string[],
  subject: string,
  html: string,
  options: SendMessageOptions = {},
): Promise<SMTPTransport.SentMessageInfo | void> => {
  if (!isArray(recipients)) {
    recipients = [recipients];
  }

  // Double-check email validity
  recipients = recipients.filter(recipient => {
    if (!recipient || !recipient.match(/.+@.+\..+/)) {
      debug(`${recipient} is an invalid email address, skipping`);
      return false;
    } else {
      return true;
    }
  }) as string[];

  // Add environment to subject if not prod
  if (config.env === 'staging') {
    subject = `[STAGING] ${subject}`;
  } else if (config.env !== 'production' && config.host.website !== 'https://opencollective.com') {
    subject = `[TESTING] ${subject}`;
  }

  let to;
  if (recipients.length > 0) {
    to = recipients.join(', ');
  }

  if (process.env.ONLY) {
    debug('Only sending email to ', process.env.ONLY);
    to = process.env.ONLY;
  } else if (config.env !== 'production') {
    if (!to) {
      debug('emailLib.sendMessage error: No recipient defined');
      return Promise.resolve();
    }

    // Filter users added as BCC
    options.bcc = filterBccForTestEnv(options.bcc);

    let sendToBcc = true;
    // Don't send to BCC if sendEvenIfNotProduction and NOT in testing env
    if (options.sendEvenIfNotProduction === true && !['ci', 'test'].includes(config.env)) {
      sendToBcc = false;
    }
    if (sendToBcc) {
      to = `emailbcc+${to.replace(/@/g, '-at-')}@opencollective.com`;
    }
  }

  if (recipients.length === 0) {
    debug('emailLib.sendMessage error: No recipient to send to, only sending to bcc', options.bcc);
  }

  const mailer = getMailer();
  if (mailer) {
    return new Promise((resolve, reject) => {
      const from = options.from || config.email.from;
      const replyTo = options.replyTo;
      const cc = options.cc;
      const bcc = options.bcc;
      const text = options.text;
      const attachments = options.attachments;

      // only attach tag in production to keep data clean
      const tag = config.env === 'production' ? options.tag : 'internal';
      const headers = { 'X-Mailgun-Tag': tag, 'X-Mailgun-Dkim': 'yes' };
      if (replyTo) {
        headers['Reply-To'] = replyTo;
      }
      if (options.accountSlug) {
        headers['X-OpenCollective-Account'] = options.accountSlug;
      }
      if (options.listId) {
        headers['List-ID'] = options.listId;
      }
      if (options.unsubscribeUrl) {
        headers['List-Unsubscribe'] = `<${options.unsubscribeUrl}>`;
        headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      }

      debug('mailer> sending email to ', to, 'bcc', bcc);

      return mailer.sendMail({ from, cc, to, bcc, subject, text, html, headers, attachments }, (err, info) => {
        if (err) {
          debug('>>> mailer.sendMail error', err);
          reportErrorToSentry(err, {
            transactionName: 'emailLib.sendMessage',
            extra: { recipients, subject, html, options },
          });
          return reject(err);
        } else {
          debug('>>> mailer.sendMail success', info);
          return resolve(info);
        }
      });
    });
  } else {
    debug('>>> mailer not configured');
    return Promise.resolve();
  }
};

/**
 * Get the label to unsubscribe from the email notification
 * Shown in the footer of the email following "To unsubscribe from "
 */
const getNotificationLabel = (template): string => {
  const notificationTypeLabels = {
    'collective.apply.for.host': 'notifications of new collectives applying to this host',
    'collective.order.created': 'notifications of new donations for this collective',
    'collective.comment.created': 'notifications of new comments submitted to this collective',
    'collective.expense.created': 'notifications of new expenses submitted to this collective',
    'collective.expense.approved.for.host': 'notifications of new expenses approved under this host',
    'collective.expense.paid.for.host': 'notifications of new expenses paid under this host',
    'collective.monthlyreport': 'monthly reports for collectives',
    'collective.member.created': 'notifications of new members',
    'collective.update.published': 'notifications of new updates from this collective',
    'host.monthlyreport': 'monthly reports for host',
    'host.yearlyreport': 'yearly reports for host',
    'collective.transaction.created': 'notifications of new transactions for this collective',
    onboarding: 'onboarding emails',
    'user.monthlyreport': 'monthly reports for backers',
    'user.yearlyreport': 'yearly reports',
    [activities.ORDER_THANKYOU]: 'thank you for your donation',
    'conversation.comment.created': 'notifications of new comments submitted to this conversation',
    'update.comment.created': 'notifications of new comments submitted to this update',
    'expense.comment.created': 'notifications of new comments submitted to this expense',
  };

  return notificationTypeLabels[template];
};

const isAuthorizedEmailDomain = email => {
  const domain = email.split('@');
  return authorizedEmailDomains.includes(domain[1].toLowerCase());
};

/*
 * Given a template, recipient and data, generates email.
 */
const generateEmailFromTemplate = (
  template,
  recipient,
  data: SendMessageData = {},
  options: SendMessageOptions = {},
) => {
  const slug = get(options, 'collective.slug') || get(data, 'collective.slug') || '';
  const hostSlug = get(data, 'host.slug');
  const eventSlug = get(data, 'event.slug');
  const projectSlug = get(data, 'project.slug');
  const emailId = get(options, 'type') || template;

  // Populate the `listId` and `accountSlug` options to later populate the email headers. We're doing that here for
  // consistency with the unsubscribe link handling below, but mutating `data` is not ideal and should be refactored.
  if (options) {
    options.listId = slug ? `${slug}::${emailId}` : emailId;
    options.accountSlug = eventSlug ?? projectSlug ?? slug;
  }

  // If we are sending the same email to multiple recipients, it doesn't make sense to allow them to unsubscribe
  if (!isArray(recipient) && !options?.isTransactional) {
    data.notificationTypeLabel = getNotificationLabel(emailId);
    if (data.notificationTypeLabel) {
      const encodedEmail = encodeURIComponent(recipient || options.bcc);
      const unsubscribeToken = generateUnsubscribeToken(recipient || options.bcc, slug || 'undefined', emailId);
      // We don't support unsubscribe at the event/project level, so we use the collective `slug`. See https://github.com/opencollective/opencollective/issues/7243.
      data.unsubscribeUrl = `${config.host.website}/email/unsubscribe/${encodedEmail}/${slug || 'undefined'}/${emailId}/${unsubscribeToken}`;
    }
  }

  if (template === 'ticket.confirmed') {
    if (slug === 'fearlesscitiesbrussels') {
      template += '.fearlesscitiesbrussels';
    }
    if (eventSlug === 'open-2020-networked-commons-initiatives-9b91f4ca') {
      template += '.open-2020';
    }
  }

  if (template === 'collective.approved') {
    if (['foundation', 'the-social-change-nest'].includes(hostSlug)) {
      template = `${template}.${hostSlug}`;
    }
  }

  if (template === 'collective.apply') {
    if (hostSlug === 'foundation') {
      template = `${template}.${hostSlug}`;
    }
  }

  if (template === 'collective.created') {
    if (['opensource', 'the-social-change-nest'].includes(hostSlug)) {
      template = `${template}.${hostSlug}`;
    }
  }

  if (template.match(/^host\.(monthly|yearly)report$/)) {
    template = 'host.report';
  }

  if (template === activities.ORDER_THANKYOU) {
    if (slug.match(/wwcode/)) {
      template = `${activities.ORDER_THANKYOU}.wwcode`;
    } else if (['foundation', 'opensource'].includes(hostSlug)) {
      template = `${activities.ORDER_THANKYOU}.${hostSlug}`;
    } else if (includes(['laprimaire', 'lesbarbares', 'enmarchebe', 'monnaie-libre'], slug)) {
      template = `${activities.ORDER_THANKYOU}.fr`;

      // xdamman: hack
      switch (data.interval) {
        case 'month':
          data.interval = 'mois';
          break;
        case 'year':
          data.interval = 'an';
          break;
      }
    }
  }

  if (template === 'collective.member.created') {
    if (get(data, 'member.memberCollective.twitterHandle') && get(data, 'member.role') === 'BACKER') {
      const collectiveMention = get(data, 'collective.twitterHandle')
        ? `@${data.collective.twitterHandle}`
        : data.collective.name;
      const text = `Hi @${
        data.member.memberCollective.twitterHandle
      } thanks for your financial contribution to ${collectiveMention} ${config.host.website}${get(
        data,
        'collective.urlPath',
      )} 🎉😊`;
      data.tweet = {
        text,
        encoded: encodeURIComponent(text),
      };
    }
  }

  data.config = pick(config, ['host']);

  if (!templates[template]) {
    return Promise.reject(new Error(`Invalid email template: ${template}`));
  }

  const renderedTemplate = render(template, data);

  return Promise.resolve(renderedTemplate);
};

const isNotificationActive = async (template, data) => {
  if (data.user && data.user.id) {
    return models.Notification.isActive(template, data.user, data.collective);
  } else {
    return true;
  }
};

/*
 * Given a template, recipient and data, generates email and sends it.
 */
const generateEmailFromTemplateAndSend = async (
  template: string,
  recipient: string,
  data: SendMessageData,
  options: SendMessageOptions = {},
) => {
  if (!recipient) {
    logger.info(`Email with template '${template}' not sent. No recipient.`);
    return;
  }

  const notificationIsActive = await isNotificationActive(template, data);
  if (!notificationIsActive) {
    logger.info(`Email with template '${template}' not sent. Recipient email notification is not active.`);
    return;
  }

  return generateEmailFromTemplate(template, recipient, data, options)
    .then(renderedTemplate => {
      const attributes = getTemplateAttributes(renderedTemplate.html);
      options.text = renderedTemplate.text;
      options.tag = template;
      options.unsubscribeUrl = data.unsubscribeUrl;
      debug(`Sending email to: ${recipient} subject: ${attributes.subject}`);
      return emailLib.sendMessage(recipient, attributes.subject, attributes.body, options);
    })
    .catch(err => {
      logger.error(err.message);
      logger.debug(err);
      reportErrorToSentry(err);
    });
};

const generateFromEmailHeader = (name, email = 'no-reply@opencollective.com') => {
  // Remove extra spaces/newlines and replace `"` by another quote character to avoid errors
  const sanitizedName = name.replace(/\s+/g, ' ').trim().replaceAll('"', '“');
  return `"${sanitizedName}" <${email}>`;
};

const emailLib = {
  render,
  sendMessage,
  generateUnsubscribeToken,
  isValidUnsubscribeToken,
  generateEmailFromTemplate,
  send: generateEmailFromTemplateAndSend,
  isAuthorizedEmailDomain,
  generateFromEmailHeader,
};

export default emailLib;

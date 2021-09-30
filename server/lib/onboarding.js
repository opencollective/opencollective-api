import Promise from 'bluebird';
import { get } from 'lodash';

import logger from '../lib/logger';
import models, { Op } from '../models';

import emailLib from './email';
import { templateNames } from './emailTemplates';

const emailOptions = {
  from: 'Open Collective <support@opencollective.com>',
  type: 'onboarding',
};

export async function processCollective(collective, template) {
  logger.info('-', collective.slug);

  // Exclude Funds from onboarding, Funds MVP, remove me after migration to FUND type
  if (get(collective, 'settings.fund') === true) {
    return;
  }

  const users = await collective.getAdminUsers();
  const unsubscribers = await models.Notification.getUnsubscribersUserIds('onboarding', collective.id);
  const recipients = users.filter(u => u && unsubscribers.indexOf(u.id) === -1).map(u => u.email);
  if (!recipients || recipients.length === 0) {
    return;
  }

  // if the collective is an open source one, we send the custom template if there is one.
  if ((collective.tags || []).includes('open source') && templateNames.includes(`${template}.opensource`)) {
    template = `${template}.opensource`;
  }

  const host = await collective.getHostCollective();
  if (host && host.slug === 'foundation' && templateNames.includes(`${template}.foundation`)) {
    template = `${template}.foundation`;
  }

  // if the collective created is an ORGANIZATION, we only send an onboarding email if there is one specific to organizations
  if (collective.type === 'ORGANIZATION') {
    const orgTemplate = `${template}.${collective.type.toLowerCase()}`;
    if (templateNames.includes(orgTemplate)) {
      template = orgTemplate;
    } else {
      logger.warn(`${orgTemplate} template not found`);
      return;
    }
  }

  logger.info(`>>> Sending ${template} email to the ${recipients.length} admin(s) of`, collective.slug);
  return Promise.map(recipients, recipient =>
    emailLib.send(template, recipient, { collective: collective.info }, emailOptions).catch(e => {
      logger.warn('Unable to send email to ', collective.slug, recipient, 'error:', e);
    }),
  );
}

export async function processOnBoardingTemplate(template, startsAt, filter = () => true) {
  const endsAt = new Date(startsAt.getFullYear(), startsAt.getMonth(), startsAt.getDate() + 1);
  logger.info(`\n>>> ${template} (from ${startsAt.toString()} to ${endsAt.toString()})`);
  try {
    let collectives = await models.Collective.findAll({
      where: {
        type: { [Op.in]: ['ORGANIZATION', 'COLLECTIVE'] },
        isActive: true,
        createdAt: { [Op.gte]: startsAt, [Op.lt]: endsAt },
      },
    });
    logger.info(`${template}> processing ${collectives.length} collectives`);
    collectives = collectives.filter(filter);
    logger.info(`${template}> processing ${collectives.length} collectives after filter`);
    collectives = await Promise.map(collectives, c => processCollective(c, template));
    logger.info(`${collectives.length} collectives processed.`);
  } catch (e) {
    logger.error('>>> error caught', e);
  }
}

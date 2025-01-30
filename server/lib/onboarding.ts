import { get } from 'lodash';
import pMap from 'p-map';

import models, { Collective, Op } from '../models';

import emailLib from './email';
import { templateNames } from './emailTemplates';
import logger from './logger';
import { reportErrorToSentry } from './sentry';

const emailOptions = {
  from: 'Open Collective <support@opencollective.com>',
  type: 'onboarding',
} as const;

const hasTemplate = (templateName: string): templateName is (typeof templateNames)[number] => {
  return (templateNames as readonly string[]).includes(templateName);
};

async function processCollective(collective: Collective, template: string) {
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

  // if the collective created is an ORGANIZATION, we only send an onboarding email if there is one specific to organizations
  if (collective.type === 'ORGANIZATION') {
    const orgTemplate = `${template}.${collective.type.toLowerCase()}`;
    if (hasTemplate(orgTemplate)) {
      template = orgTemplate;
    } else {
      logger.warn(`${orgTemplate} template not found`);
      return;
    }
  }

  logger.info(`>>> Sending ${template} email to the ${recipients.length} admin(s) of`, collective.slug);
  const data = { collective: collective.info, recipientName: collective.name || collective.legalName };
  return pMap(recipients, recipient =>
    emailLib.send(template, recipient, data, emailOptions).catch(e => {
      logger.warn('Unable to send email to ', collective.slug, recipient, 'error:', e);
    }),
  );
}

export async function processOnBoardingTemplate(template, startsAt, filter = null) {
  const endsAt = new Date(startsAt.getFullYear(), startsAt.getMonth(), startsAt.getDate() + 1);
  logger.info(`\n>>> ${template} (from ${startsAt.toString()} to ${endsAt.toString()})`);
  try {
    const collectives = await models.Collective.findAll({
      where: {
        type: { [Op.in]: ['ORGANIZATION', 'COLLECTIVE'] },
        isActive: true,
        createdAt: { [Op.gte]: startsAt, [Op.lt]: endsAt },
      },
    });
    logger.info(`${template}> processing ${collectives.length} collectives`);

    const filteredCollectives = [];
    for (const collective of collectives) {
      if (!filter || (await filter(collective))) {
        filteredCollectives.push(collective);
      }
    }

    logger.info(`${template}> processing ${collectives.length} collectives after filter`);
    const results = await pMap(filteredCollectives, c => processCollective(c, template));
    logger.info(`${results.length} collectives processed.`);
  } catch (e) {
    logger.error('>>> error caught', e);
    reportErrorToSentry(e);
  }
}

export async function processHostOnBoardingTemplate(template: string, HostCollectiveId: number, startsAt: Date) {
  const endsAt = new Date(startsAt.getFullYear(), startsAt.getMonth(), startsAt.getDate() + 1);
  logger.info(`\n>>> ${template} (from ${startsAt.toString()} to ${endsAt.toString()})`);
  try {
    const collectives = await models.Collective.findAll({
      where: {
        type: 'COLLECTIVE',
        isActive: true,
        HostCollectiveId,
        approvedAt: { [Op.gte]: startsAt, [Op.lt]: endsAt },
      },
    });

    logger.info(`${template}> processing ${collectives.length} collectives`);
    const results = await pMap(collectives, c => processCollective(c, template));
    logger.info(`${results.length} collectives processed.`);
  } catch (e) {
    logger.error('>>> error caught', e);
    reportErrorToSentry(e);
  }
}

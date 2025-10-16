import '../../server/env';

import config from 'config';

import { checkAllModels } from '../../checks/model';
import email from '../../server/lib/email';
import logger from '../../server/lib/logger';
import { HandlerType, reportErrorToSentry } from '../../server/lib/sentry';
import slackLib, { OPEN_COLLECTIVE_SLACK_CHANNEL } from '../../server/lib/slack';
import { runCronJob } from '../utils';

const recipients = 'ops@opencollective.com';

const subject = 'Daily Checks failed';

const failureMessage = 'The Daily Checks failed today with the following errors:';
const fixMessage = 'To fix the models, try:';
const fixCommand = 'npm run script checks/model -- --fix';

async function run() {
  const { errors } = await checkAllModels();

  if (errors.length > 0) {
    // Post on Slack
    if (config.slack.webhooks.engineeringAlerts) {
      try {
        await slackLib.postMessageToOpenCollectiveSlack(
          [failureMessage, ...errors.map(msg => `- ${msg}`), '', `${fixMessage} ${fixCommand}`].join('\n'),
          OPEN_COLLECTIVE_SLACK_CHANNEL.ENGINEERING_ALERTS,
        );
      } catch (error) {
        reportErrorToSentry(error, { handler: HandlerType.CRON, extra: { errors } });
      }
    }

    // Send email
    logger.info('Sending checks report to ops@opencollective.com');
    const html = `${failureMessage}<br>\n<br>\n${errors
      .map(msg => `<li> ${msg}`)
      .join('\n')}<br>\n<br>\n${fixMessage} <code>${fixCommand}</code>`;

    const text = `${failureMessage}\n\n${errors.map(msg => `- ${msg}`).join('\n')}\n\n${fixMessage} ${fixCommand}`;

    return email.sendMessage(recipients, subject, html, { text });
  }
}

if (require.main === module) {
  runCronJob('checks', run, 24 * 60 * 60);
}

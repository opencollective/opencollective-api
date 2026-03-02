/**
 * Daily CRON job to verify that the PayPal API scopes configured on host ConnectedAccounts
 * are consistent with the PayPal features they have enabled (paypalPayouts, paypalDonations).
 *
 * If any mismatches are found, a report is posted to the engineering-alerts Slack channel.
 * See: https://github.com/opencollective/opencollective/issues/8381
 */

import '../../server/env';

import config from 'config';

import FEATURE from '../../server/constants/feature';
import { hasFeature } from '../../server/lib/allowed-features';
import logger from '../../server/lib/logger';
import { getHostsWithPayPalConnected } from '../../server/lib/paypal';
import { reportErrorToSentry, HandlerType } from '../../server/lib/sentry';
import slackLib, { OPEN_COLLECTIVE_SLACK_CHANNEL } from '../../server/lib/slack';
import { checkPaypalScopes, retrieveGrantedScopes } from '../../server/paymentProviders/paypal/api';
import { runCronJob } from '../utils';

const DRY_RUN = process.env.DRY_RUN === 'true';

interface ScopeIssue {
  hostSlug: string;
  feature: FEATURE;
  missingScopes: string[];
}

const run = async () => {
  const hosts = await getHostsWithPayPalConnected();
  logger.info(`Checking PayPal API scopes for ${hosts.length} host(s)...`);

  const allIssues: ScopeIssue[] = [];
  const errors: string[] = [];

  for (const host of hosts) {
    try {
      const [connectedAccount] = await host.getConnectedAccounts({
        where: { service: 'paypal' },
        order: [['createdAt', 'DESC']],
        limit: 1,
      });

      if (!connectedAccount?.clientId || !connectedAccount?.token) {
        continue;
      }

      const grantedScopes = await retrieveGrantedScopes(connectedAccount.clientId, connectedAccount.token);

      const enabledFeatures = [FEATURE.PAYPAL_PAYOUTS, FEATURE.PAYPAL_DONATIONS].filter(f => hasFeature(host, f));

      const issues = checkPaypalScopes(grantedScopes, enabledFeatures);
      for (const issue of issues) {
        allIssues.push({ hostSlug: host.slug, ...issue });
        logger.warn(
          `[${host.slug}] PayPal feature "${issue.feature}" is enabled but missing scopes: ${issue.missingScopes.join(', ')}`,
        );
      }
    } catch (err) {
      const msg = `Failed to check PayPal scopes for host "${host.slug}": ${err.message}`;
      logger.error(msg);
      errors.push(msg);
      reportErrorToSentry(err, { handler: HandlerType.CRON, extra: { hostSlug: host.slug } });
    }
  }

  if (allIssues.length === 0 && errors.length === 0) {
    logger.info('All PayPal host accounts have the required API scopes configured correctly.');
    return;
  }

  const lines: string[] = ['*PayPal API Scope Check — Daily Report*'];

  if (allIssues.length > 0) {
    lines.push('');
    lines.push(`*Scope Mismatches (${allIssues.length}):*`);
    for (const issue of allIssues) {
      lines.push(
        `• \`${issue.hostSlug}\` | Feature: \`${issue.feature}\` | Missing: ${issue.missingScopes.join(', ')}`,
      );
    }
    lines.push('');
    lines.push(
      'These hosts have PayPal features enabled that require additional API scopes. Please verify their PayPal application settings at https://developer.paypal.com/developer/applications.',
    );
  }

  if (errors.length > 0) {
    lines.push('');
    lines.push(`*Errors during check (${errors.length}):*`);
    for (const err of errors) {
      lines.push(`• ${err}`);
    }
  }

  const message = lines.join('\n');
  logger.info(message);

  if (!DRY_RUN && config.slack?.webhooks?.engineeringAlerts) {
    try {
      await slackLib.postMessageToOpenCollectiveSlack(message, OPEN_COLLECTIVE_SLACK_CHANNEL.ENGINEERING_ALERTS);
    } catch (slackError) {
      logger.error('Failed to post PayPal scope check report to Slack', slackError);
      reportErrorToSentry(slackError, { handler: HandlerType.CRON });
    }
  }
};

if (require.main === module) {
  runCronJob('check-paypal-enabled-apis', run, 24 * 60 * 60);
}

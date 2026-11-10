import '../../server/env';

import config from 'config';
import { QueryTypes } from 'sequelize';

import { SUPPORTED_CURRENCIES } from '../../server/constants/currencies';
import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

const MAX_STALENESS_DAYS = 7;

/**
 * `cron/daily/90-register-currency-exchange-rates` stores the rates from USD once a day, and SQL
 * conversions (collection queries, contributors, the `getRatesFromDb` fallback) silently reuse the
 * latest rate they find. A currency that stops being recorded therefore keeps converting at an
 * outdated rate without any error: this happened to 57 currencies from 2026-03-21.
 *
 * Fails when a supported currency has no rate from USD for more than a week. There is no fix: the
 * rates must come from the provider, see the cron job logs and Sentry.
 *
 * Only meaningful where the cron runs: dev and test databases hold seeded rates that never refresh.
 */
export async function checkUsdExchangeRatesAreNotStale() {
  if (!['production', 'staging'].includes(config.env)) {
    logger.info('Skipping checkUsdExchangeRatesAreNotStale: FX rates are only recorded in production and staging');
    return;
  }

  // One index lookup per currency on ("currency", "createdAt")
  const results = await sequelize.query<{ currency: string; lastRecordedAt: Date | null }>(
    `
    SELECT c.currency, (
      SELECT MAX(u."createdAt") FROM "UsdExchangeRates" u WHERE u."currency" = c.currency
    ) AS "lastRecordedAt"
    FROM UNNEST(ARRAY[:currencies]::varchar[]) AS c(currency)
    `,
    { type: QueryTypes.SELECT, raw: true, replacements: { currencies: [...SUPPORTED_CURRENCIES] } },
  );

  const threshold = Date.now() - MAX_STALENESS_DAYS * 24 * 60 * 60 * 1000;
  const staleCurrencies = results.filter(
    ({ lastRecordedAt }) => !lastRecordedAt || new Date(lastRecordedAt).getTime() < threshold,
  );

  if (staleCurrencies.length > 0) {
    logger.warn(
      `Stale currencies:\n${staleCurrencies
        .map(
          ({ currency, lastRecordedAt }) =>
            `${currency}: ${lastRecordedAt ? new Date(lastRecordedAt).toISOString() : 'never'}`,
        )
        .join('\n')}`,
    );
    throw new Error(
      `No FX rate recorded for more than ${MAX_STALENESS_DAYS} days: ${staleCurrencies.map(c => c.currency).join(', ')}`,
    );
  }
}

export const checks = [checkUsdExchangeRatesAreNotStale];

if (!module.parent) {
  runAllChecksThenExit(checks);
}

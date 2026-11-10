import { QueryInterface, QueryTypes } from 'sequelize';

/**
 * From 2026-03-21, `cron/daily/90-register-currency-exchange-rates` stopped at MRO every day (Fixer
 * rejects it as a base currency), so the 57 currencies after it in `SUPPORTED_CURRENCIES` (MUR to
 * ZMW, including NZD, SEK, PLN, ZAR) have no rates as base currency since then.
 *
 * USD -> X kept being recorded every day, so the missing X -> Y rates are derived from that day's
 * USD rates: rate(X -> Y) = rate(USD -> Y) / rate(USD -> X). On 2026-03-20, the last day with direct
 * rates, this matches the direct rates within 0.001% (540 pairs compared).
 *
 * A row is only inserted for a (base currency, day) that has no rate at all, so currencies and days
 * recorded by the cron are left untouched and the migration can run again safely. MRO is skipped:
 * it was replaced by MRU and is no longer supported. Backfilled rows get the `createdAt` of the
 * USD -> X row they derive from, so date lookups (`createdAt <= :date`) pick them as usual.
 *
 * Processed one month at a time to keep each statement around 250k rows.
 */
const START_DATE = '2026-03-21';
const SKIPPED_CURRENCIES = ['USD', 'MRO'];

module.exports = {
  async up(queryInterface: QueryInterface) {
    const insertedByMonth: Record<string, number> = {};
    const end = new Date();
    for (
      let monthStart = new Date(`${START_DATE}T00:00:00Z`);
      monthStart < end;
      monthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1))
    ) {
      const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
      const [result] = await queryInterface.sequelize.query<{ count: number }>(
        `
        WITH usd AS (
          SELECT DISTINCT ON (DATE_TRUNC('day', u."createdAt"), u."to")
            DATE_TRUNC('day', u."createdAt") AS day,
            u."to" AS currency,
            u.rate,
            u."createdAt"
          FROM "CurrencyExchangeRates" u
          WHERE u."from" = 'USD'
            AND u."deletedAt" IS NULL
            AND u."createdAt" >= :monthStart
            AND u."createdAt" < :monthEnd
            AND u.rate > 0
          ORDER BY DATE_TRUNC('day', u."createdAt"), u."to", u."createdAt" DESC
        ), covered AS (
          -- (base currency, day) pairs the cron recorded, found through the ("from", "to", "createdAt") index
          SELECT DISTINCT e."from" AS currency, DATE_TRUNC('day', e."createdAt") AS day
          FROM (SELECT DISTINCT currency FROM usd) b
          JOIN "CurrencyExchangeRates" e
            ON e."from" = b.currency
            AND e."to" = 'USD'
            AND e."deletedAt" IS NULL
            AND e."createdAt" >= :monthStart
            AND e."createdAt" < :monthEnd
        ), inserted AS (
          INSERT INTO "CurrencyExchangeRates" ("from", "to", rate, "createdAt", "updatedAt")
          SELECT x.currency, y.currency, y.rate / x.rate, x."createdAt", NOW()
          FROM usd x
          JOIN usd y ON y.day = x.day
          WHERE x.currency NOT IN (:skippedCurrencies)
            AND NOT EXISTS (SELECT 1 FROM covered c WHERE c.currency = x.currency AND c.day = x.day)
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM inserted
        `,
        {
          type: QueryTypes.SELECT,
          replacements: { monthStart, monthEnd, skippedCurrencies: SKIPPED_CURRENCIES },
        },
      );
      insertedByMonth[monthStart.toISOString().slice(0, 7)] = result.count;
    }

    await queryInterface.sequelize.query(
      `
      INSERT INTO "MigrationLogs" ("type", "createdAt", "description", "data")
      VALUES ('MIGRATION', NOW(), '20261110120000-backfill-currency-exchange-rates-from-usd', :data)
      `,
      { replacements: { data: JSON.stringify({ insertedByMonth }) } },
    );
  },

  async down() {
    // Backfilled rows can't be told apart from recorded ones (there is no source column): the
    // inserted counts are in MigrationLogs. Nothing to undo automatically.
  },
};

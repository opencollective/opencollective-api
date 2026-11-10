import type { QueryInterface } from 'sequelize';

/**
 * Stores only the USD -> X rates, in "UsdExchangeRates", and turns "CurrencyExchangeRates" into a
 * view that computes every pair from them: X -> Y = (USD -> Y) / (USD -> X), on the same day.
 *
 * "CurrencyExchangeRates" kept every pair (137 x 137 rows a day, 30.5M rows, 4 GB). A pair computed
 * from USD differs from the one Fixer returned by at most 1e-5 (relative), since Fixer computes
 * them the same way. The view keeps the columns of the table, so the queries and reports that read
 * it don't change. Inserts and deletes on the view go to "UsdExchangeRates" (see the triggers).
 *
 * The old table is kept as "CurrencyExchangeRatesArchive", to compare and roll back. Dropping it is
 * left to a later migration.
 */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      const query = (sql: string) => queryInterface.sequelize.query(sql, { transaction });

      await query(`
        CREATE TABLE "UsdExchangeRates" (
          "id" SERIAL PRIMARY KEY,
          "currency" VARCHAR(255) NOT NULL,
          "rate" DOUBLE PRECISION NOT NULL,
          "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          -- The rates of one day are written a few milliseconds apart: pairs are matched by day
          "day" DATE GENERATED ALWAYS AS (("createdAt" AT TIME ZONE 'UTC')::date) STORED
        )
      `);

      // About 300k rows: every day since 2018 has USD-based rates. One rate per currency and day,
      // the latest (the job rarely ran twice a day).
      await query(`
        INSERT INTO "UsdExchangeRates" ("currency", "rate", "createdAt", "updatedAt")
        SELECT DISTINCT ON ("to", ("createdAt" AT TIME ZONE 'UTC')::date)
          "to", "rate", "createdAt", COALESCE("updatedAt", "createdAt")
        FROM "CurrencyExchangeRates"
        WHERE "from" = 'USD'
        AND "deletedAt" IS NULL
        AND "rate" > 0
        ORDER BY "to", ("createdAt" AT TIME ZONE 'UTC')::date, "createdAt" DESC
      `);

      // USD -> USD (1) is the leg of every X -> USD and USD -> X pair. Fixer doesn't always return it.
      await query(`
        INSERT INTO "UsdExchangeRates" ("currency", "rate", "createdAt", "updatedAt")
        SELECT 'USD', 1, MIN("createdAt"), MIN("createdAt")
        FROM "UsdExchangeRates"
        GROUP BY "day"
        HAVING NOT BOOL_OR("currency" = 'USD')
      `);

      await query(
        `CREATE INDEX "usd_exchange_rates__currency_created_at" ON "UsdExchangeRates" ("currency", "createdAt")`,
      );
      // One rate per currency and day, or the view would return a pair several times
      await query(`CREATE UNIQUE INDEX "usd_exchange_rates__currency_day" ON "UsdExchangeRates" ("currency", "day")`);

      await query(`ALTER TABLE "CurrencyExchangeRates" RENAME TO "CurrencyExchangeRatesArchive"`);

      // "createdAt" is the one of the "to" leg, so that a lookup of the latest rate of a pair
      // (ORDER BY "createdAt" DESC LIMIT 1) walks the ("currency", "createdAt") index backwards
      // and stops at the first day that has the "from" leg.
      await query(`
        CREATE VIEW "CurrencyExchangeRates" AS
        SELECT
          y."id",
          x."currency" AS "from",
          y."currency" AS "to",
          y."rate" / x."rate" AS "rate",
          y."createdAt",
          y."updatedAt",
          NULL::TIMESTAMP WITH TIME ZONE AS "deletedAt"
        FROM "UsdExchangeRates" y
        INNER JOIN "UsdExchangeRates" x ON x."day" = y."day"
      `);

      // Every day with rates must have USD -> USD, or the pairs involving USD would be missing
      await query(`
        CREATE FUNCTION usd_exchange_rates_add_usd() RETURNS TRIGGER AS $$
        BEGIN
          IF NEW."currency" <> 'USD' THEN
            INSERT INTO "UsdExchangeRates" ("currency", "rate", "createdAt", "updatedAt")
            VALUES ('USD', 1, NEW."createdAt", NEW."createdAt")
            ON CONFLICT ("currency", "day") DO NOTHING;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await query(`
        CREATE TRIGGER usd_exchange_rates_add_usd
        AFTER INSERT ON "UsdExchangeRates"
        FOR EACH ROW EXECUTE FUNCTION usd_exchange_rates_add_usd()
      `);

      // Writes on the view: USD -> X is stored as is, X -> USD as USD -> X = 1 / rate. A second
      // rate for the same currency and day replaces the first one if it's more recent.
      await query(`
        CREATE FUNCTION currency_exchange_rates_insert() RETURNS TRIGGER AS $$
        DECLARE
          created_at TIMESTAMP WITH TIME ZONE := COALESCE(NEW."createdAt", NOW());
        BEGIN
          IF NEW."from" = NEW."to" THEN
            RETURN NEW;
          ELSIF NEW."from" = 'USD' THEN
            INSERT INTO "UsdExchangeRates" ("currency", "rate", "createdAt", "updatedAt")
            VALUES (NEW."to", NEW."rate", created_at, COALESCE(NEW."updatedAt", created_at))
            ON CONFLICT ("currency", "day") DO UPDATE
            SET "rate" = EXCLUDED."rate", "createdAt" = EXCLUDED."createdAt", "updatedAt" = EXCLUDED."updatedAt"
            WHERE EXCLUDED."createdAt" >= "UsdExchangeRates"."createdAt"
            RETURNING "id" INTO NEW."id";
          ELSIF NEW."to" = 'USD' THEN
            INSERT INTO "UsdExchangeRates" ("currency", "rate", "createdAt", "updatedAt")
            VALUES (NEW."from", 1 / NEW."rate", created_at, COALESCE(NEW."updatedAt", created_at))
            ON CONFLICT ("currency", "day") DO UPDATE
            SET "rate" = EXCLUDED."rate", "createdAt" = EXCLUDED."createdAt", "updatedAt" = EXCLUDED."updatedAt"
            WHERE EXCLUDED."createdAt" >= "UsdExchangeRates"."createdAt";
          ELSE
            RAISE EXCEPTION 'Only rates from or to USD are stored, got % -> %', NEW."from", NEW."to";
          END IF;
          NEW."createdAt" := created_at;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await query(`
        CREATE TRIGGER currency_exchange_rates_insert
        INSTEAD OF INSERT ON "CurrencyExchangeRates"
        FOR EACH ROW EXECUTE FUNCTION currency_exchange_rates_insert()
      `);

      // Deleting USD -> X deletes the stored rate. Other pairs are computed: nothing to delete.
      await query(`
        CREATE FUNCTION currency_exchange_rates_delete() RETURNS TRIGGER AS $$
        BEGIN
          IF OLD."from" = 'USD' THEN
            DELETE FROM "UsdExchangeRates" WHERE "id" = OLD."id";
          END IF;
          RETURN OLD;
        END;
        $$ LANGUAGE plpgsql
      `);
      await query(`
        CREATE TRIGGER currency_exchange_rates_delete
        INSTEAD OF DELETE ON "CurrencyExchangeRates"
        FOR EACH ROW EXECUTE FUNCTION currency_exchange_rates_delete()
      `);
    });
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      const query = (sql: string) => queryInterface.sequelize.query(sql, { transaction });

      await query(`DROP VIEW "CurrencyExchangeRates"`);
      await query(`DROP FUNCTION currency_exchange_rates_insert()`);
      await query(`DROP FUNCTION currency_exchange_rates_delete()`);
      await query(`ALTER TABLE "CurrencyExchangeRatesArchive" RENAME TO "CurrencyExchangeRates"`);

      // Rates recorded since the migration: only USD-based ones (the other pairs were computed)
      await query(`
        INSERT INTO "CurrencyExchangeRates" ("from", "to", "rate", "createdAt", "updatedAt")
        SELECT 'USD', u."currency", u."rate", u."createdAt", u."updatedAt"
        FROM "UsdExchangeRates" u
        WHERE u."createdAt" > (SELECT COALESCE(MAX("createdAt"), '-infinity') FROM "CurrencyExchangeRates")
      `);

      await query(`DROP TABLE "UsdExchangeRates"`);
      await query(`DROP FUNCTION usd_exchange_rates_add_usd()`);
    });
  },
};

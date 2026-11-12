import '../../server/env';

import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

export async function checkCollectivePaymentMethodsCurrencies({ fix = false } = {}) {
  const message = 'Collective payment method must have the same currency as the host';

  const results = await sequelize.query<{
    paymentMethodId: number;
    collectiveSlug: string | null;
    hostSlug: string | null;
    collectiveCurrency: string | null;
    hostCurrency: string | null;
    paymentMethodCurrency: string | null;
  }>(
    `
    SELECT
      pm.id AS "paymentMethodId",
      c.slug AS "collectiveSlug",
      host.slug AS "hostSlug",
      c.currency AS "collectiveCurrency",
      host.currency AS "hostCurrency",
      pm.currency AS "paymentMethodCurrency"
    FROM "Collectives" c
    INNER JOIN "Collectives" host ON host.id = c."HostCollectiveId"
    INNER JOIN "PaymentMethods" pm ON c.id = pm."CollectiveId" AND pm.service = 'opencollective' AND pm.type = 'collective'
    WHERE c."deletedAt" IS NULL
    AND c."isActive" IS TRUE
    AND host."deletedAt" IS NULL
    AND pm."deletedAt" IS NULL
    AND pm.currency != host.currency
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    if (!fix) {
      throw new Error(message);
    }

    for (const result of results) {
      logger.info(
        `Fixing payment method ${result.paymentMethodId} for ${result.collectiveSlug}: ${result.paymentMethodCurrency} -> ${result.hostCurrency}`,
      );

      await sequelize.query(`UPDATE "PaymentMethods" SET currency = :hostCurrency WHERE id = :paymentMethodId`, {
        replacements: { hostCurrency: result.hostCurrency, paymentMethodId: result.paymentMethodId },
      });
    }
  }
}

/**
 * The "Added Funds" payment method (opencollective/host) of a host must be in the host currency.
 * Payment methods that were already used in transactions are ignored, as they're part of the history.
 */
export async function checkHostPaymentMethodsCurrencies({ fix = false } = {}) {
  const message = 'Host payment method must have the same currency as the host';

  const results = await sequelize.query<{
    paymentMethodId: number;
    hostSlug: string;
    hostCurrency: string;
    paymentMethodCurrency: string | null;
    hasPaymentMethodInHostCurrency: boolean;
  }>(
    `
    SELECT
      pm.id AS "paymentMethodId",
      host.slug AS "hostSlug",
      host.currency AS "hostCurrency",
      pm.currency AS "paymentMethodCurrency",
      EXISTS (
        SELECT 1
        FROM "PaymentMethods" other
        WHERE other."CollectiveId" = host.id
        AND other.service = 'opencollective'
        AND other.type = 'host'
        AND other.currency = host.currency
        AND other."deletedAt" IS NULL
      ) AS "hasPaymentMethodInHostCurrency"
    FROM "Collectives" host
    INNER JOIN "PaymentMethods" pm ON host.id = pm."CollectiveId" AND pm.service = 'opencollective' AND pm.type = 'host'
    WHERE host."deletedAt" IS NULL
    AND host."hasMoneyManagement" IS TRUE
    AND pm."deletedAt" IS NULL
    AND pm.currency IS DISTINCT FROM host.currency
    AND NOT EXISTS (SELECT 1 FROM "Transactions" t WHERE t."PaymentMethodId" = pm.id AND t."deletedAt" IS NULL)
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    if (!fix) {
      throw new Error(message);
    }

    for (const result of results) {
      if (result.hasPaymentMethodInHostCurrency) {
        // A payment method in the right currency was already created (see `getOrCreateHostPaymentMethod`), the stale one is unused
        logger.info(
          `Deleting unused payment method ${result.paymentMethodId} for ${result.hostSlug}: ${result.paymentMethodCurrency} (host currency is ${result.hostCurrency})`,
        );
        await sequelize.query(`UPDATE "PaymentMethods" SET "deletedAt" = NOW() WHERE id = :paymentMethodId`, {
          replacements: { paymentMethodId: result.paymentMethodId },
        });
      } else {
        logger.info(
          `Fixing payment method ${result.paymentMethodId} for ${result.hostSlug}: ${result.paymentMethodCurrency} -> ${result.hostCurrency}`,
        );
        await sequelize.query(`UPDATE "PaymentMethods" SET currency = :hostCurrency WHERE id = :paymentMethodId`, {
          replacements: { hostCurrency: result.hostCurrency, paymentMethodId: result.paymentMethodId },
        });
      }
    }
  }
}

export const checks = [checkCollectivePaymentMethodsCurrencies, checkHostPaymentMethodsCurrencies];

if (!module.parent) {
  runAllChecksThenExit(checks);
}

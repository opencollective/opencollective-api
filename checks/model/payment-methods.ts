import '../../server/env';

import { sequelize } from '../../server/models';

import { runCheckThenExit } from './_utils';

async function checkCollectivePaymentMethodsCurrencies({ fix = false } = {}) {
  const message = 'Collective payment method must have the same currency as the host';

  const results = await sequelize.query(
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
    AND pm.currency != host.currency`,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    if (!fix) {
      throw new Error(message);
    }

    for (const result of results) {
      console.log(
        `Fixing payment method ${result.id} for ${result.slug}: ${result.paymentMethodCurrency} -> ${result.hostCurrency}`,
      );

      await sequelize.query(
        `UPDATE "PaymentMethods" SET currency = $hostCurrency WHERE id = $paymentMethodId
        `,
        { bind: { hostCurrency: result.hostCurrency, paymentMethodId: result.paymentMethodId } },
      );
    }
  }
}

export async function checkPaymentMethods({ fix = false } = {}) {
  await checkCollectivePaymentMethodsCurrencies({ fix });
}

if (!module.parent) {
  runCheckThenExit(checkPaymentMethods);
}

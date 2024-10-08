import '../../server/env';

import { sequelize } from '../../server/models';
import { runCronJob } from '../utils';

// we have to use raw sql query today
// https://github.com/sequelize/sequelize/issues/3957

if (require.main === module) {
  runCronJob(
    'clean-orders',
    () =>
      Promise.all([
        // Mark all Manual Payments as EXPIRED after 2 months
        // (Until August 2020, it used to be ERROR instead of EXPIRED)
        sequelize.query(
          `UPDATE "Orders"
  SET "status" = 'EXPIRED', "updatedAt" = NOW()
  FROM "Collectives"
  WHERE "Orders"."status" = 'PENDING'
  AND "Orders"."PaymentMethodId" IS NULL
  AND "Collectives"."id" = "Orders"."CollectiveId"
  AND "Collectives"."HostCollectiveId" IS NOT NULL
  AND "Orders"."createdAt" <  (NOW() - interval '2 month')
  `,
        ),
        // Mark all paused Orders as EXPIRED after 1 year
        sequelize.query(
          `UPDATE "Orders"
  SET "status" = 'EXPIRED', "updatedAt" = NOW()
  WHERE "Orders"."status" = 'PAUSED'
  AND "Orders"."updatedAt" <  (NOW() - interval '1 year')
  `,
        ),
      ]),
    24 * 60 * 60,
  );
}

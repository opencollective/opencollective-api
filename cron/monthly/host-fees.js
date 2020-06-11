#!/usr/bin/env node
import '../../server/env';

import { v4 as uuid } from 'uuid';

import { sumTransactions } from '../../server/lib/hostlib';
import models, { Op } from '../../server/models';

// Only run on the first of the month
const today = new Date();
if (process.env.NODE_ENV === 'production' && today.getDate() !== 1 && !process.env.OFFCYCLE) {
  console.log('NODE_ENV is production and today is not the first of month, script aborted!');
  process.exit();
}

const d = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();
const rd = new Date(d.getFullYear(), d.getMonth() - 1);

const year = rd.getFullYear();
const month = rd.getMonth();

const date = new Date();
date.setFullYear(year);
date.setMonth(month);

const startDate = new Date(date.getFullYear(), date.getMonth(), 1);
const endDate = new Date(date.getFullYear(), date.getMonth() + 1, 1);

const dateRange = {
  createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
};

async function run() {
  const hostsWhere = {
    isHostAccount: true,
    isActive: true,
    HostCollectiveId: { [Op.ne]: null },
  };

  if (process.env.SLUGS) {
    const slugs = process.env.SLUGS.split(',').map(s => s.trim());
    hostsWhere.slug = { [Op.in]: slugs };
  }
  if (process.env.SKIP_SLUGS) {
    const slugs = process.env.SKIP_SLUGS.split(',').map(s => s.trim());
    hostsWhere.slug = { [Op.notIn]: slugs };
  }

  const hosts = await models.Collective.findAll({
    where: hostsWhere,
  });

  for (const host of hosts) {
    const where = { HostCollectiveId: host.id };
    const whereWithDateRange = { ...where, ...dateRange };

    // We copy what is currently done in the Host Report
    const hostFees = await sumTransactions(
      'hostFeeInHostCurrency',
      {
        where: {
          ...whereWithDateRange,
          [Op.or]: [
            { type: 'CREDIT', OrderId: { [Op.ne]: null } },
            { type: 'DEBIT', ExpenseId: { [Op.ne]: null } },
          ],
        },
      },
      host.currency,
    );

    const amount = Math.abs(hostFees.totalInHostCurrency);
    if (!amount) {
      continue;
    }

    const monthAsString = date.toLocaleString('default', { month: 'long' });
    const description = `Host Fees ${monthAsString} ${year}`;

    const payload = {
      type: 'CREDIT',
      amount,
      description: description,
      currency: host.currency,
      CollectiveId: host.id,
      FromCollectiveId: host.id,
      HostCollectiveId: host.id,
      hostCurrency: host.currency,
      hostCurrencyFxRate: 1,
      amountInHostCurrency: amount,
      netAmountInCollectiveCurrency: amount,
      TransactionGroup: uuid(),
    };

    console.log(`Adding Host Fees ${monthAsString} ${year} for ${host.slug}`);
    await models.Transaction.create(payload);
  }
}

if (require.main === module) {
  run()
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}

import '../../server/env';

import config from 'config';
import _ from 'lodash';
import { QueryTypes } from 'sequelize';

import emailLib from '../../server/lib/email';
import queries from '../../server/lib/queries';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { formatCurrencyObject } from '../../server/lib/utils';
import type { Collective } from '../../server/models';
import models, { Op, sequelize } from '../../server/models';
import { runCronJob } from '../utils';

/** Row shape of `GetCollectiveTransactionsQuery` */
type CollectiveTransactionsRow = {
  CollectiveId: number;
  HostCollectiveId: number | null;
  amountInHostCurrency: string;
  hostCurrency: string;
  platformFeeInHostCurrency: string;
  hostFeeInHostCurrency: string;
  paymentProcessorFeeInHostCurrency: string;
  hostSlug: string;
  hostName: string;
  hostLogo: string;
  hostTwitterHandle: string;
  hostDescription: string;
  slug: string;
  name: string;
  description: string;
  image: string;
  backgroundImage: string;
  twitterHandle: string;
  settings: unknown;
  data: unknown;
};

/** A collective listed in the yearly report */
type YearlyCollectiveInfo = {
  slug: string;
  name: string;
  description: string;
  image: string;
  backgroundImage: string;
  twitterHandle: string;
  settings: unknown;
  data: unknown;
  totalDonations: number;
  tier: string;
  currency: string;
};

/** A host (or the platform fees pseudo-host) of the yearly report */
type YearlyHostInfo = {
  slug?: string;
  name: string;
  image?: string;
  twitterHandle?: string;
  description?: string;
  totalFees?: Record<string, number>;
  collectivesBySlug?: Record<string, YearlyCollectiveInfo>;
  collectives?: YearlyCollectiveInfo[];
};

/** Data passed to the `user.yearlyreport` template */
type YearlyReportData = {
  stats: {
    totalCollectives: number;
    totalDonations: Record<string, number>;
    totalDonationsString: string;
  };
  fees: { stripe: Record<string, number>; opencollective: Record<string, number> };
  hosts: Record<string, YearlyHostInfo>;
  year: number;
  collective?: unknown;
  platformStats?: unknown;
  recipients?: string[];
};

// Only run on the first of the year
const today = new Date();

const d = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();
const startDate = new Date(`${d.getFullYear() - 1}`);
const endDate = new Date(`${d.getFullYear()}`);
const year = startDate.getFullYear();

console.log('startDate', startDate, 'endDate', endDate);

let platformStats,
  totalUsersProcessed = 0,
  totalUsersSkipped = 0;

const GetCollectiveTransactionsQuery = `
with "CollectiveTransactions" as (
  SELECT
    "CollectiveId",
    MAX("HostCollectiveId") as "HostCollectiveId",
    SUM("amountInHostCurrency") as "amountInHostCurrency",
    MAX("hostCurrency") as "hostCurrency",
    SUM("platformFeeInHostCurrency") as "platformFeeInHostCurrency",
    MAX("hostFeeInHostCurrency") as "hostFeeInHostCurrency",
    MAX("paymentProcessorFeeInHostCurrency") as "paymentProcessorFeeInHostCurrency"
  FROM "Transactions"
  WHERE "FromCollectiveId"=:FromCollectiveId AND amount > 0 AND "deletedAt" IS NULL
  AND "createdAt" >= :startDate AND "createdAt" < :endDate
  GROUP BY "CollectiveId"
)
SELECT
  ut.*,
  host.slug as "hostSlug",
  host.name as "hostName",
  host.image as "hostLogo", host."twitterHandle" as "hostTwitterHandle", host.description as "hostDescription",
  c.slug, c.name, c.description, c.image, c."backgroundImage", c."twitterHandle", c.settings, c.data
FROM "CollectiveTransactions" ut
LEFT JOIN "Collectives" c ON ut."CollectiveId" = c.id
LEFT JOIN "Collectives" host ON ut."HostCollectiveId" = host.id
WHERE c.type = 'COLLECTIVE'
`;

const getPlatformStats = async () => {
  return {
    totalCollectives: await queries.getTotalNumberOfActiveCollectives(startDate, endDate),
    totalAnnualBudget: await queries.getTotalAnnualBudget(),
  };
};

const processCollective = (collective: Collective) => {
  return sequelize
    .query<CollectiveTransactionsRow>(GetCollectiveTransactionsQuery, {
      type: QueryTypes.SELECT,
      replacements: { FromCollectiveId: collective.id, startDate, endDate },
    })
    .then(transactions => {
      if (!transactions || transactions.length === 0) {
        totalUsersSkipped++;
        return Promise.reject(`No transaction for ${collective.slug}, skipping`);
      }
      console.log('>>> processing collective', collective.slug);
      totalUsersProcessed++;
      const hosts: Record<string, YearlyHostInfo> = {
        opencollective: { name: 'Platform fees' },
        stripe: { name: 'Credit Card Processing Fees (Stripe)' },
      };
      const totalCollectives = transactions.length;
      const totalDonations: Record<string, number> = {};
      const collectivesBySlug: Record<string, YearlyCollectiveInfo> = {};
      transactions.forEach(row => {
        if (!row.hostName) {
          return console.log('>>> no hostname for', row);
        }
        if (typeof hosts[row.hostSlug] === 'undefined') {
          hosts[row.hostSlug] = {
            slug: row.hostSlug,
            name: row.hostName.trim() || row.hostSlug,
            image: row.hostLogo,
            twitterHandle: row.hostTwitterHandle,
            description: row.hostDescription,
            collectivesBySlug: {},
          };
        }

        collectivesBySlug[row.slug] = {
          slug: row.slug,
          name: row.name || row.slug,
          description: row.description,
          image: row.image,
          backgroundImage:
            row.backgroundImage || 'https://opencollective.com/public/images/collectives/default-header-bg.jpg',
          twitterHandle: row.twitterHandle,
          settings: row.settings,
          data: row.data,
          totalDonations: Number(row.amountInHostCurrency),
          tier: 'total contributed',
          currency: row.hostCurrency,
        };

        hosts[row.hostSlug].collectivesBySlug[row.slug] = collectivesBySlug[row.slug];

        if (typeof totalDonations[row.hostCurrency] === 'undefined') {
          totalDonations[row.hostCurrency] = 0;
        }

        _.set(hosts, [row.hostSlug, 'totalFees', row.hostCurrency], 0);
        _.set(hosts, ['stripe', 'totalFees', row.hostCurrency], 0);
        _.set(hosts, ['opencollective', 'totalFees', row.hostCurrency], 0);

        totalDonations[row.hostCurrency] += Number(row.amountInHostCurrency);
        hosts[row.hostSlug]['totalFees'][row.hostCurrency] += Number(row.hostFeeInHostCurrency);
        hosts['opencollective']['totalFees'][row.hostCurrency] += Number(row.platformFeeInHostCurrency);
        hosts['stripe']['totalFees'][row.hostCurrency] += Number(row.paymentProcessorFeeInHostCurrency);
      });

      for (const hostSlug in hosts) {
        if (!hosts[hostSlug].collectivesBySlug) {
          continue;
        }
        for (const collectiveSlug in hosts[hostSlug].collectivesBySlug) {
          hosts[hostSlug].collectives = hosts[hostSlug].collectives || [];
          hosts[hostSlug].collectives.push(hosts[hostSlug].collectivesBySlug[collectiveSlug]);
        }
        hosts[hostSlug].collectives.sort((a, b) => {
          if (a.totalDonations > b.totalDonations) {
            return -1;
          } else {
            return 1;
          }
        });
      }

      const fees = {
        stripe: hosts['stripe'].totalFees,
        opencollective: hosts['opencollective'].totalFees,
      };

      delete hosts['stripe'];
      delete hosts['opencollective'];

      return {
        stats: {
          totalCollectives,
          totalDonations,
          totalDonationsString: formatCurrencyObject(totalDonations),
        },
        fees,
        hosts,
        year,
      };
    })
    .then((data: YearlyReportData) => {
      return getUsers(collective).then(users => {
        data.collective = collective.info;
        data.platformStats = platformStats;
        data.recipients = users.map(u => u.email);
        if (data.recipients.length > 1) {
          console.log('>>> recipients for ', collective.type.toLowerCase(), collective.slug, ':', data.recipients);
        }
        if (data.recipients.length > 0) {
          // `emailLib.send` is typed with a single recipient but supports arrays at runtime (see its `isArray` check)
          // @ts-expect-error passing multiple recipients, supported by `emailLib.send`
          return emailLib.send('user.yearlyreport', data.recipients, data);
        }
      });
    })
    .catch(error => {
      console.error(error);
      reportErrorToSentry(error);
    });
};

const getHosts = async () => {
  const members = await models.Member.findAll({
    attributes: [[sequelize.fn('DISTINCT', sequelize.col('MemberCollectiveId')), 'MemberCollectiveId']],
    where: { role: 'HOST' },
  });
  return members.map(m => m.MemberCollectiveId);
};

const getCollectives = () => {
  const where: { slug?: { [Op.in]: string[] } } = {};
  if (process.env.DEBUG && process.env.DEBUG.match(/preview/)) {
    where.slug = {
      [Op.in]: ['xdamman', 'digitalocean', 'fbopensource', 'piamancini', 'brusselstogether', 'wwcode'],
    };
  }

  if (process.env.SLUGS) {
    const slugs = process.env.SLUGS.split(',');
    where.slug = { [Op.in]: slugs };
  }

  return models.Collective.findAll({
    where: { ...where, type: { [Op.in]: ['ORGANIZATION', 'USER'] } },
  });
};

const getUsers = (collective: Collective) => {
  return models.Notification.findAll({
    where: {
      channel: 'email',
      CollectiveId: collective.id,
      type: 'user.yearlyreport',
      active: false,
    },
  }).then(unsubscriptions => {
    const excludeUnsubscribed: { id?: { [Op.notIn]: number[] } } = {};
    const unsubscribedUserIds = unsubscriptions.map(u => u.UserId);
    if (unsubscribedUserIds.length > 0) {
      console.log(
        `${unsubscribedUserIds.length} users have unsubscribed from the user.yearlyreport report for collective ${collective.slug}`,
      );
    }

    if (unsubscribedUserIds.length > 0) {
      excludeUnsubscribed.id = { [Op.notIn]: unsubscribedUserIds };
    }
    if (collective.type === 'USER') {
      return models.User.findAll({
        where: { CollectiveId: collective.id, ...excludeUnsubscribed },
        include: [
          {
            model: models.Collective,
            as: 'collective',
            attributes: ['slug', 'name'],
          },
        ],
      });
    } else if (collective.type === 'ORGANIZATION') {
      return models.Member.findAll({
        where: { CollectiveId: collective.id, role: 'ADMIN' },
      }).then(memberships =>
        models.User.findAll({
          where: {
            CollectiveId: {
              [Op.in]: memberships.map(m => m.MemberCollectiveId),
            },
            ...excludeUnsubscribed,
          },
          include: [
            {
              model: models.Collective,
              as: 'collective',
              attributes: ['slug', 'name'],
            },
          ],
        }),
      );
    }
  });
};

const init = () => {
  const startTime = new Date();
  let hosts;
  return getPlatformStats()
    .then(stats => (platformStats = stats))
    .then(() => getHosts())
    .then(h => (hosts = h))
    .then(() => getCollectives())
    .then(collectives =>
      Promise.all(
        collectives.map(collective => {
          if (hosts.indexOf(collective.id) !== -1) {
            totalUsersSkipped++;
            return console.log(collective.slug, 'is a host, skipping');
          }
          return processCollective(collective);
        }),
      ),
    )
    .then(() => {
      const timeLapsed = Math.round((new Date().getTime() - startTime.getTime()) / 1000);
      console.log('Total user/organizations processed: ', totalUsersProcessed);
      console.log('Total user/organizations skipped: ', totalUsersSkipped);
      console.log(`Total run time: ${timeLapsed}s`);
    });
};

if (require.main === module) {
  if (config.env === 'production' && today.getDate() !== 1 && today.getMonth() !== 0 && !process.env.OFFCYCLE) {
    console.log('OC_ENV is production and today is not the first of year, script aborted!');
    process.exit();
  }

  process.env.PORT = '3066';
  runCronJob('yearly-user-report', init, 23 * 60 * 60);
}

#!/usr/bin/env node
import '../../server/env.js';
import '../../server/lib/sentry.js';

import config from 'config';
import merge from 'deepmerge';
import _ from 'lodash-es';
import moment from 'moment-timezone';
import fetch from 'node-fetch';
import showdown from 'showdown';

import activities from '../../server/constants/activities.js';
import expenseStatus from '../../server/constants/expense_status.js';
import { reduceArrayToCurrency } from '../../server/lib/currency.js';
import emailLib from '../../server/lib/email.js';
import { formatCurrency, pluralize } from '../../server/lib/utils.js';
import models, { Op } from '../../server/models/index.js';

const markdownConverter = new showdown.Converter();

if (!process.env.MANUAL) {
  onlyExecuteInProdOnMondays();
}

const { Activity, Collective, Expense, PaymentMethod, Transaction } = models;

/**
 * Note: we cannot simply compare last week with the same week in the previous month
 * because that wouldn't always include the first of the month (when all the recurring subscriptions are processed)
 * So instead, we compare last week with the same date of the previous month + 7 days
 * Eg. we compare the week of Monday July 30 2018 till Sunday August 5 2018 (technically till Monday August 6 not included)
 *     with the week of Wednesday June 30th till Tuesday July 5 (technically till Wednesday July 6 not included)
 */
const lastWeek = [
  moment(process.env.START_DATE).tz('UTC').startOf('isoWeek').subtract(1, 'week'),
  moment(process.env.START_DATE).tz('UTC').startOf('isoWeek'),
];
const sameDatesLastMonth = [
  moment(lastWeek[0]).subtract(1, 'month'),
  moment(lastWeek[0]).subtract(1, 'month').add(7, 'days'),
];

const createdLastWeek = getTimeFrame('createdAt', lastWeek);
const updatedLastWeek = getTimeFrame('updatedAt', lastWeek);
const createdSameWeekPreviousMonth = getTimeFrame('createdAt', sameDatesLastMonth);
const updatedSameWeekPreviousMonth = getTimeFrame('updatedAt', sameDatesLastMonth);
const sinceISOString = lastWeek[0].toISOString();
const title = 'Weekly Platform Report';
const subtitle = `Week ${lastWeek[0].week()} from ${lastWeek[0].format('YYYY-MM-DD')} till ${lastWeek[1].format(
  'YYYY-MM-DD',
)} (compared to ${sameDatesLastMonth[0].format('YYYY-MM-DD')} till ${sameDatesLastMonth[1].format('YYYY-MM-DD')})`;

const donation = {
  where: {
    OrderId: {
      [Op.not]: null,
    },
  },
};

const pendingExpense = { where: { status: expenseStatus.PENDING } };
const approvedExpense = { where: { status: expenseStatus.APPROVED } };
const rejectedExpense = { where: { status: expenseStatus.REJECTED } };
const paidExpense = { where: { status: expenseStatus.PAID } };

const credit = { where: { type: 'CREDIT' } };

const excludeOcTeam = {
  where: {
    CollectiveId: {
      [Op.not]: 1, // OpenCollective collective
    },
  },
};

const feesOnTop = {
  where: {
    CollectiveId: 1,
    type: 'CREDIT',
    data: { isFeesOnTop: true },
  },
};

const lastWeekDonations = merge({}, createdLastWeek, donation, excludeOcTeam, credit);
const lastWeekExpenses = merge({}, updatedLastWeek, excludeOcTeam);

const pendingLastWeekExpenses = merge({}, lastWeekExpenses, pendingExpense);
const approvedLastWeekExpenses = merge({}, lastWeekExpenses, approvedExpense);
const rejectedLastWeekExpenses = merge({}, lastWeekExpenses, rejectedExpense);
const paidLastWeekExpenses = merge({}, lastWeekExpenses, paidExpense);

const weekBeforeDonations = merge({}, createdSameWeekPreviousMonth, donation, excludeOcTeam, credit);
const paidWeekBeforeExpenses = merge({}, updatedSameWeekPreviousMonth, excludeOcTeam, paidExpense);

const groupAndOrderBy = (table, attribute = 'currency') => {
  return {
    plain: false,
    group: [`${table}.${attribute}`],
    attributes: [[attribute, 'currency']],
    order: [attribute],
  };
};

const onlyIncludeCollectiveType = {
  include: [
    {
      model: Collective,
      as: 'collective',
      where: {
        type: 'COLLECTIVE',
      },
    },
  ],
};

const service = service => {
  return {
    include: [
      {
        attributes: [],
        model: PaymentMethod,
        required: true,
        where: {
          service,
        },
      },
    ],
  };
};

const paypalReceived = { where: { type: activities.WEBHOOK_PAYPAL_RECEIVED } };

const distinct = {
  plain: false,
  distinct: true,
};

function printIssues(issues, limit = 10) {
  const resArray = [];
  for (let i = 0; i < Math.min(limit, issues.length); i++) {
    const issue = issues[i];
    const labels = issue.labels.map(label => label.name);
    const labelsStr = labels.length > 0 ? ` #${labels.join(' #')}` : '';
    resArray.push(`- ${moment(issue.updated_at).format('DD/MM')} [${issue.title}](${issue.url})${labelsStr}<br>
Created ${moment(issue.created_at).fromNow()} by [${issue.user.login}](${issue.user.html_url}) | ${
      issue.assignee ? `assigned to ${issue.assignee.login}` : 'not assigned'
    }${issue.comments > 0 ? ` | ${issue.comments} ${pluralize('comment', issue.comments)}` : ''}`);
  }
  return resArray.join('\n\n');
}

function getLatestIssues(state = 'open') {
  const url = `https://api.github.com/repos/opencollective/opencollective/issues?state=${state}&per_page=50&since=${sinceISOString}`;
  return fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  }).then(response => response.json());
}

export default async function run() {
  try {
    const results = {
      // Donation statistics

      stripeDonationCount: await Transaction.count(merge({}, lastWeekDonations, service('stripe'))),

      priorStripeDonationCount: await Transaction.count(merge({}, weekBeforeDonations, service('stripe'))),

      manualDonationCount: await Transaction.count(merge({}, lastWeekDonations, service('opencollective'))),

      priorManualDonationCount: await Transaction.count(merge({}, weekBeforeDonations, service('opencollective'))),

      paypalDonationCount: await Transaction.count(merge({}, lastWeekDonations, service('paypal'))),

      priorPaypalDonationCount: await Transaction.count(merge({}, weekBeforeDonations, service('paypal'))),

      revenue: await Transaction.aggregate(
        'platformFeeInHostCurrency',
        'SUM',
        merge({}, lastWeekDonations, groupAndOrderBy('Transaction', 'hostCurrency')),
      ),

      priorRevenue: await Transaction.aggregate(
        'platformFeeInHostCurrency',
        'SUM',
        merge({}, weekBeforeDonations, groupAndOrderBy('Transaction', 'hostCurrency')),
      ),

      feesOnTop: await Transaction.aggregate('amount', 'SUM', merge({}, lastWeekDonations, feesOnTop)),

      priorFeesOnTop: await Transaction.aggregate('amount', 'SUM', merge({}, weekBeforeDonations, feesOnTop)),

      stripeDonationAmount: await Transaction.aggregate(
        'amount',
        'SUM',
        merge({}, lastWeekDonations, groupAndOrderBy('Transaction'), service('stripe')),
      ),

      priorStripeDonationAmount: await Transaction.aggregate(
        'amount',
        'SUM',
        merge({}, weekBeforeDonations, groupAndOrderBy('Transaction'), service('stripe')),
      ),

      manualDonationAmount: await Transaction.aggregate(
        'amount',
        'SUM',
        merge({}, lastWeekDonations, groupAndOrderBy('Transaction'), service('opencollective')),
      ),

      priorManualDonationAmount: await Transaction.aggregate(
        'amount',
        'SUM',
        merge({}, weekBeforeDonations, groupAndOrderBy('Transaction'), service('opencollective')),
      ),

      paypalReceivedCount: await Activity.count(merge({}, createdLastWeek, paypalReceived)),

      paypalDonationAmount: await Transaction.sum('amount', merge({}, lastWeekDonations, service('paypal'))),

      priorPaypalDonationAmount: await Transaction.sum('amount', merge({}, weekBeforeDonations, service('paypal'))),

      // Expense statistics

      pendingExpenseCount: await Expense.count(pendingLastWeekExpenses),

      approvedExpenseCount: await Expense.count(approvedLastWeekExpenses),

      rejectedExpenseCount: await Expense.count(rejectedLastWeekExpenses),

      paidExpenseCount: await Expense.count(paidLastWeekExpenses),

      priorPaidExpenseCount: await Expense.count(paidWeekBeforeExpenses),

      pendingExpenseAmount: await Expense.aggregate(
        'amount',
        'SUM',
        merge({}, pendingLastWeekExpenses, groupAndOrderBy('Expense')),
      ).map(row => `${row.currency} ${formatCurrency(row.SUM, row.currency)}`),

      approvedExpenseAmount: await Expense.aggregate(
        'amount',
        'SUM',
        merge({}, approvedLastWeekExpenses, groupAndOrderBy('Expense')),
      ).map(row => `${row.currency} ${formatCurrency(row.SUM, row.currency)}`),

      rejectedExpenseAmount: await Expense.aggregate(
        'amount',
        'SUM',
        merge({}, rejectedLastWeekExpenses, groupAndOrderBy('Expense')),
      ).map(row => `${row.currency} ${formatCurrency(row.SUM, row.currency)}`),

      paidExpenseAmount: await Expense.aggregate(
        'amount',
        'SUM',
        merge({}, paidLastWeekExpenses, groupAndOrderBy('Expense')),
      ),

      priorPaidExpenseAmount: await Expense.aggregate(
        'amount',
        'SUM',
        merge({}, paidWeekBeforeExpenses, groupAndOrderBy('Expense')),
      ),

      // Collective statistics

      activeCollectivesWithTransactions: await Transaction.findAll(
        merge({ attributes: ['CollectiveId'] }, createdLastWeek, distinct, excludeOcTeam, onlyIncludeCollectiveType),
      ).map(row => row.CollectiveId),

      priorActiveCollectivesWithTransactions: await Transaction.findAll(
        merge(
          { attributes: ['CollectiveId'] },
          createdSameWeekPreviousMonth,
          distinct,
          excludeOcTeam,
          onlyIncludeCollectiveType,
        ),
      ).map(row => row.CollectiveId),

      activeCollectivesWithExpenses: await Expense.findAll(
        merge({ attributes: ['CollectiveId'] }, updatedLastWeek, distinct, excludeOcTeam),
      ).map(row => row.CollectiveId),

      priorActiveCollectivesWithExpenses: await Expense.findAll(
        merge({ attributes: ['CollectiveId'] }, updatedSameWeekPreviousMonth, distinct, excludeOcTeam),
      ).map(row => row.CollectiveId),

      newCollectives: await Collective.findAll(
        merge({}, { attributes: ['slug', 'name', 'tags'], where: { type: 'COLLECTIVE' } }, createdLastWeek),
      ).map(collective => {
        const openSource = collective.dataValues.tags && collective.dataValues.tags.indexOf('open source') !== -1;
        return `[${collective.dataValues.name || collective.dataValues.slug}](https://opencollective.com/${
          collective.dataValues.slug
        }) (${openSource ? 'open source' : collective.dataValues.tags})`;
      }),

      priorNewCollectivesCount: await Collective.count(
        merge({}, { where: { type: 'COLLECTIVE' } }, createdSameWeekPreviousMonth),
      ),

      openIssues: await getLatestIssues('open'),
      closedIssues: await getLatestIssues('closed'),
    };

    // Account for Fees On Top in the Revenue
    results.revenue = results.revenue.map(r => {
      if (r.currency === 'USD') {
        // Revenue is negative here, that's why we subtract
        return { ...r, SUM: r.SUM - results.feesOnTop };
      } else {
        return r;
      }
    });
    results.priorRevenue = results.revenue.map(r => {
      if (r.currency === 'USD') {
        // Revenue is negative here, that's why we subtract
        return { ...r, SUM: r.SUM - results.priorFeesOnTop };
      } else {
        return r;
      }
    });
    results.revenueInUSD = -(await reduceArrayToCurrency(
      results.revenue.map(({ SUM, currency }) => {
        return { amount: SUM, currency };
      }),
    ));
    results.priorRevenueInUSD = -(await reduceArrayToCurrency(
      results.priorRevenue.map(({ SUM, currency }) => {
        return { amount: SUM, currency };
      }),
    ));
    results.activeCollectiveCount = _.union(
      results.activeCollectivesWithTransactions,
      results.activeCollectivesWithExpenses,
    ).length;
    results.priorActiveCollectiveCount = _.union(
      results.priorActiveCollectivesWithTransactions,
      results.priorActiveCollectivesWithExpenses,
    ).length;

    const report = reportString(results);
    console.log(report);

    const html = markdownConverter.makeHtml(report);
    const data = {
      title,
      html,
    };
    await emailLib.send('report.platform.weekly', 'team@opencollective.com', data);
    console.log('Weekly reporting done!');
    process.exit();
  } catch (err) {
    console.log('err', err);
    process.exit();
  }
}

/**
 * Heroku scheduler only has daily or hourly cron jobs, we only want to run
 * this script once per week on Monday (1). If the day is not Monday on production
 * we won't execute the script
 */
function onlyExecuteInProdOnMondays() {
  const today = new Date();
  if (config.env === 'production' && today.getDay() !== 1) {
    console.log('OC_ENV is production and day is not Monday, script aborted!');
    process.exit();
  }
}

function getTimeFrame(propName, timeRange) {
  return {
    where: {
      [propName]: {
        [Op.gte]: timeRange[0],
        [Op.lt]: timeRange[1],
      },
    },
  };
}

function reportString({
  activeCollectiveCount,
  approvedExpenseAmount,
  approvedExpenseCount,
  stripeDonationAmount,
  stripeDonationCount,
  manualDonationAmount,
  manualDonationCount,
  newCollectives,
  paidExpenseAmount,
  paidExpenseCount,
  paypalDonationAmount,
  paypalDonationCount,
  pendingExpenseAmount,
  pendingExpenseCount,
  revenue,
  priorRevenue,
  revenueInUSD,
  priorRevenueInUSD,
  feesOnTop,
  priorFeesOnTop,
  priorActiveCollectiveCount,
  priorStripeDonationAmount,
  priorStripeDonationCount,
  priorManualDonationAmount,
  priorManualDonationCount,
  priorNewCollectivesCount,
  priorPaidExpenseAmount,
  priorPaypalDonationAmount,
  priorPaypalDonationCount,
  priorPaidExpenseCount,
  rejectedExpenseAmount,
  rejectedExpenseCount,
  openIssues,
  closedIssues,
}) {
  const growth = (revenueInUSD - priorRevenueInUSD) / priorRevenueInUSD;
  const growthPercent = `${Math.round(growth * 100)}%`;
  const feesOnTopGrowth = (feesOnTop - priorFeesOnTop) / priorFeesOnTop;
  const feesOnTopGrowthPercent = `${Math.round(feesOnTopGrowth * 100)}%`;
  return `# ${title}
${subtitle}

## Revenue ${formatCurrency(revenueInUSD, 'USD')} (${compareNumbers(revenueInUSD, priorRevenueInUSD, n =>
    formatCurrency(n, 'USD'),
  )}) (${growthPercent} growth)
  ${revenue
    .map(
      ({ SUM, currency }) =>
        `* ${currency} ${formatCurrency(-SUM, currency)} (${compareNumbers(-SUM, -getSum(priorRevenue, currency), n =>
          formatCurrency(n, currency),
        )}) ${currency === 'USD' ? '¹' : ''}`,
    )
    .join('\n  ')}

  ¹ _Fees on Top account for ${formatCurrency(feesOnTop, 'USD')} of the total USD revenue. (${compareNumbers(
    feesOnTop,
    priorFeesOnTop,
    n => formatCurrency(n, 'USD'),
  )}) (${feesOnTopGrowthPercent} growth)_

## Donations
  - STRIPE: ${stripeDonationCount} donations received (${compareNumbers(stripeDonationCount, priorStripeDonationCount)})
    ${stripeDonationAmount
      .map(
        ({ SUM, currency }) =>
          `* ${currency} ${formatCurrency(SUM, currency)} (${compareNumbers(
            SUM,
            getSum(priorStripeDonationAmount, currency),
            n => formatCurrency(n, currency),
          )})`,
      )
      .join('\n    ')}
  - PAYPAL: ${paypalDonationCount} paypal donations received (${compareNumbers(
    paypalDonationCount,
    priorPaypalDonationCount,
  )})
    * USD ${formatCurrency(paypalDonationAmount, 'USD')} (${compareNumbers(
      paypalDonationAmount,
      priorPaypalDonationAmount,
      n => formatCurrency(n, 'USD'),
    )})
  - MANUAL: ${manualDonationCount} donations received (${compareNumbers(manualDonationCount, priorManualDonationCount)})
    ${manualDonationAmount
      .map(
        ({ SUM, currency }) =>
          `* ${currency} ${formatCurrency(SUM, currency)} (${compareNumbers(
            SUM,
            getSum(priorManualDonationAmount, currency),
            n => formatCurrency(n, currency),
          )})`,
      )
      .join('\n    ')}

## Expenses
  - ${paidExpenseCount} paid expenses (${compareNumbers(paidExpenseCount, priorPaidExpenseCount)})
    ${paidExpenseAmount
      .map(
        ({ SUM, currency }) =>
          `* ${currency} ${formatCurrency(SUM, currency)}  (${compareNumbers(
            SUM,
            getSum(priorPaidExpenseAmount, currency),
            n => formatCurrency(n, currency),
          )})`,
      )
      .join('\n    ')}
  - ${pendingExpenseCount} pending expenses${displayTotals(pendingExpenseAmount)}
  - ${approvedExpenseCount} approved expenses${displayTotals(approvedExpenseAmount)}
  - ${rejectedExpenseCount} rejected expenses${displayTotals(rejectedExpenseAmount)}

## Collectives
  - ${activeCollectiveCount} active collectives (${compareNumbers(activeCollectiveCount, priorActiveCollectiveCount)})
  - ${newCollectives.length} new collectives (${compareNumbers(
    newCollectives.length,
    priorNewCollectivesCount,
  )})${displayCollectives(newCollectives)}

## ${closedIssues.length} issues closed last week
${printIssues(closedIssues, 10)}

[View all closed issues](https://github.com/opencollective/opencollective/issues?utf8=%E2%9C%93&q=is%3Aissue+is%3Aclosed+)

## ${openIssues.length} open issues created or updated last week
${printIssues(openIssues, 10)}

[View all open issues](https://github.com/opencollective/opencollective/issues)
`;
}

function displayTotals(totals) {
  if (totals.length > 0) {
    return `\n    * ${totals.join('\n    * ').trim()}`;
  }
  return '';
}

function displayCollectives(collectives) {
  if (collectives.length > 0) {
    return `:\n    * ${collectives.join('\n    * ').trim()}`;
  }
  return '';
}

function compareNumbers(recentNumber, priorNumber, formatter = number => number) {
  const diff = Math.round(recentNumber - priorNumber);
  return `${diff >= 0 ? '+' : ''}${formatter(diff)}`;
}

function getSum(collection, currency) {
  const record = _.find(collection, { currency });
  return record ? record.SUM : 0;
}

run();

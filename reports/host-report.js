import Promise from 'bluebird';
import config from 'config';
import debugLib from 'debug';
import { groupBy, keyBy, pick, round, sumBy } from 'lodash';
import moment from 'moment';

import MemberRoles from '../server/constants/roles.ts';
import emailLib from '../server/lib/email';
import { getBackersStats, getHostedCollectives, sumTransactions } from '../server/lib/hostlib';
import { stripHTML } from '../server/lib/sanitize-html';
import { getTransactions } from '../server/lib/transactions';
import { exportToPDF, sumByWhen } from '../server/lib/utils';
import models, { Op, sequelize } from '../server/models';

const debug = debugLib('hostreport');

const summary = {
  totalHosts: 0,
  totalActiveHosts: 0,
  totalCollectives: 0,
  totalActiveCollectives: 0,
  numberTransactions: 0,
  numberDonations: 0,
  numberPaidExpenses: 0,
  hosts: [],
};

async function HostReport(year, month, hostId) {
  let startDate, endDate;

  const d = new Date();
  d.setFullYear(year);
  let yearlyReport = false;
  if (typeof month === 'number') {
    d.setMonth(month);
    startDate = new Date(d.getFullYear(), d.getMonth(), 1);
    endDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  } else {
    // yearly report
    month = '';
    yearlyReport = true;
    startDate = new Date(d.getFullYear(), 0, 1);
    endDate = new Date(d.getFullYear() + 1, 0, 1);
  }

  const endDateIncluded = moment(endDate).subtract(1, 'days').toDate();

  const dateRange = {
    createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
  };

  const emailTemplate = yearlyReport ? 'host.yearlyreport' : 'host.monthlyreport'; // NOTE: this will be later converted to 'host.report'
  const reportName = yearlyReport ? `${year} Yearly Host Report` : `${year}/${month + 1} Monthly Host Report`;
  const dateFormat = yearlyReport ? 'YYYY' : 'YYYYMM';
  const csvFilename = `${moment(d).format(dateFormat)}-transactions.csv`;
  const pdfFilename = `${moment(d).format(dateFormat)}-expenses.pdf`;
  console.log('startDate', startDate, 'endDate', endDate);

  year = year || startDate.getFullYear();

  let previewCondition = '';
  if (process.env.DEBUG && process.env.DEBUG.match(/preview/)) {
    previewCondition = 'AND c.id IN (11004, 9804, 9802, 9801)';
  } // open source collective host, wwcode host, brusselstogether, changex
  // previewCondition = "AND c.id IN (9802)"; // brusselstogether

  if (hostId) {
    previewCondition = `AND c.id = ${hostId}`;
  }

  if (process.env.SLUGS) {
    const slugs = process.env.SLUGS.split(',');
    previewCondition = `AND c.slug IN ('${slugs.join("','")}')`;
  }
  if (process.env.SKIP_SLUGS) {
    const slugs = process.env.SKIP_SLUGS.split(',');
    previewCondition = `AND c.slug NOT IN ('${slugs.join("','")}')`;
  }

  const getHostStats = async (host, collectiveids) => {
    // Since collectives can change host,
    // we don't fetch transactions based on the CollectiveId but based on the HostCollectiveId
    // at the time of the transaction
    const where = { HostCollectiveId: host.id };
    const whereWithDateRange = { ...where, ...dateRange };

    return {
      balance: await sumTransactions(
        'netAmountInCollectiveCurrency',
        { where: { ...where, createdAt: { [Op.lt]: endDate } } },
        host.currency,
      ), // total host balance
      totalMoneyManaged:
        (
          await sumTransactions(
            'amountInHostCurrency',
            { where: { ...where, createdAt: { [Op.lt]: endDate } } },
            host.currency,
          )
        ).totalInHostCurrency +
        (
          await sumTransactions(
            'paymentProcessorFeeInHostCurrency',
            { where: { ...where, createdAt: { [Op.lt]: endDate } } },
            host.currency,
          )
        ).totalInHostCurrency +
        (
          await sumTransactions(
            'platformFeeInHostCurrency',
            { where: { ...where, createdAt: { [Op.lt]: endDate } } },
            host.currency,
          )
        ).totalInHostCurrency,
      delta: await sumTransactions('netAmountInCollectiveCurrency', { where: whereWithDateRange }, host.currency), // delta host balance last month
      backers: await getBackersStats(startDate, endDate, collectiveids),
    };
  };

  const processHost = async host => {
    try {
      summary.totalHosts++;
      console.log('>>> Processing host', host.slug);
      const data = {},
        attachments = [];
      const note = 'using fxrate of the day of the transaction as provided by the ECB. Your effective fxrate may vary.';
      const expensesPerPage = 30; // number of expenses per page of the Table Of Content (for PDF export)

      let collectivesById = {};
      let page = 1;
      let currentPage = 0;

      data.host = host.info;
      data.collective = host.info;
      data.reportDate = endDate;
      data.reportName = reportName;
      data.month = !yearlyReport && moment(startDate).format('MMMM');
      data.year = year;
      data.startDate = startDate;
      data.endDate = endDate;
      data.endDateIncluded = endDateIncluded;
      data.config = pick(config, 'host');
      data.maxSlugSize = 0;
      data.notes = null;
      data.expensesPerPage = [[]];
      data.taxType = host.getTaxType() || 'Taxes';
      data.stats = {};

      const getHostAdminsEmails = host => {
        if (host.type === 'USER') {
          return models.User.findAll({ where: { CollectiveId: host.id } }).map(u => u.email);
        }
        return models.Member.findAll({
          where: {
            CollectiveId: host.id,
            role: { [Op.or]: [MemberRoles.ADMIN, MemberRoles.ACCOUNTANT] },
          },
        }).map(
          admin => {
            return models.User.findOne({
              attributes: ['email'],
              where: { CollectiveId: admin.MemberCollectiveId },
            }).then(user => user.email);
          },
          { concurrency: 1 },
        );
      };

      const processTransaction = async transaction => {
        const t = {
          ...transaction.info,
          Expense: transaction.Expense
            ? {
                ...transaction.Expense.info,
                items: transaction.Expense.items.map(item => item.dataValues),
                PayoutMethod: transaction.Expense.PayoutMethod,
              }
            : null,
        };
        t.collective = collectivesById[t.CollectiveId].dataValues;
        t.collective.shortSlug = t.collective.slug.replace(/^wwcode-?(.)/, '$1');
        t.notes = t.Expense && t.Expense.privateMessage && stripHTML(t.Expense.privateMessage);
        if (t.data && t.data.fxrateSource) {
          t.notes = t.notes ? `${t.notes} (${note})` : note;
          data.notes = note;
        }
        t.source = t.ExpenseId ? 'EXPENSE' : t.OrderId ? 'ORDER' : 'OTHER';

        // We prepare expenses for the PDF export
        if (t.type === 'DEBIT' && t.ExpenseId) {
          t.page = page++;
          if ((page - 1) % expensesPerPage === 0) {
            currentPage++;
            data.expensesPerPage[currentPage] = [];
          }
          data.expensesPerPage[currentPage].push(t);
        }

        data.maxSlugSize = Math.max(data.maxSlugSize, t.collective.shortSlug.length + 1);
        if (!t.description) {
          const source = await transaction.getSource();
          t.description = source.description;
        }
        return t;
      };

      const collectives = await getHostedCollectives(host.id, startDate, endDate);
      collectivesById = keyBy(collectives, 'id');
      data.stats.totalCollectives = collectives.filter(c => c.type === 'COLLECTIVE').length;
      summary.totalCollectives += data.stats.totalCollectives;
      console.log(`>>> processing ${data.stats.totalCollectives} collectives`);
      let transactions = await getTransactions(Object.keys(collectivesById), startDate, endDate, {
        where: { HostCollectiveId: host.id },
        include: [
          {
            model: models.Expense,
            include: [
              'fromCollective',
              {
                model: models.ExpenseItem,
                as: 'items',
                where: {
                  url: { [Op.not]: null },
                },
              },
              { model: models.PayoutMethod, attributes: ['type'] },
            ],
          },
          {
            model: models.User,
            as: 'createdByUser',
          },
          { model: models.PaymentMethod, attributes: ['service', 'type'] },
        ],
      });

      if (!transactions || transactions.length == 0) {
        throw new Error('No transaction found');
      }
      console.log(`>>> processing ${transactions.length} transactions`);
      transactions = await Promise.all(transactions.map(processTransaction));
      const csv = models.Transaction.exportCSV(transactions, collectivesById);
      attachments.push({
        filename: `${host.slug}-${csvFilename}`,
        content: csv,
      });
      data.transactions = transactions;
      // Don't generate PDF in email if it's the yearly report
      let pdf;
      if (!yearlyReport && !process.env.SKIP_PDF) {
        pdf = await exportToPDF('expenses', data, {
          paper: host.currency === 'USD' ? 'Letter' : 'A4',
        }).catch(error => {
          console.error(error);
          return;
        });
      }

      // Mailgun limit is 25MB
      if (pdf && pdf.length < 24000000) {
        attachments.push({
          filename: `${host.slug}-${pdfFilename}`,
          content: pdf,
        });
        data.expensesPdf = true;
      }
      const stats = await getHostStats(host, Object.keys(collectivesById));

      const groupedTransactions = groupBy(data.transactions, t => {
        if (t.OrderId && t.type === 'CREDIT') {
          return 'donations';
        } else if (t.ExpenseId && t.type === 'DEBIT') {
          return 'expenses';
          // TODO REPLACE WITH OTHER INCOMES AND OTHER EXPENSES
        } else if (t.type === 'DEBIT') {
          return 'otherDebits';
        } else if (t.type === 'CREDIT') {
          return 'otherCredits';
        }
      });

      const donations = groupedTransactions.donations || [];
      const expenses = groupedTransactions.expenses || [];
      const otherCredits = groupedTransactions.otherCredits || [];
      const otherDebits = groupedTransactions.otherDebits || [];

      const plan = await host.getPlan();

      const totalAmountDonations = sumBy(donations, 'amountInHostCurrency');
      const paymentProcessorFees = sumBy(donations, 'paymentProcessorFeeInHostCurrency');
      const platformFees = sumBy(donations, 'platformFeeInHostCurrency');
      const totalAmountOtherCredits = sumBy(otherCredits, 'amountInHostCurrency');
      const paymentProcessorFeesOtherCredits = sumBy(otherCredits, 'paymentProcessorFeeInHostCurrency');
      const platformFeesOtherCredits = sumBy(otherCredits, 'platformFeeInHostCurrency');
      const totalAmountOtherDebits = sumBy(otherDebits, 'amountInHostCurrency');
      const paymentProcessorFeesOtherDebits = sumBy(otherDebits, 'paymentProcessorFeeInHostCurrency');
      const platformFeesOtherDebits = sumBy(otherDebits, 'platformFeeInHostCurrency');
      const payoutProcessorFeesPaypal = sumByWhen(
        expenses,
        'paymentProcessorFeeInHostCurrency',
        t => t.Expense?.PayoutMethod?.type === 'PAYPAL',
      );
      const payoutProcessorFeesTransferWise = sumByWhen(
        expenses,
        'paymentProcessorFeeInHostCurrency',
        t => t.Expense?.PayoutMethod?.type === 'BANK_ACCOUNT',
      );
      const payoutProcessorFeesOther = sumByWhen(
        expenses,
        'paymentProcessorFeeInHostCurrency',
        t => (t.Expense && !t.Expense.PayoutMethod) || t.Expense?.PayoutMethod?.type === 'OTHER',
      );
      const totalNetAmountReceived =
        totalAmountDonations +
        paymentProcessorFees +
        platformFees +
        totalAmountOtherCredits +
        paymentProcessorFeesOtherCredits +
        platformFeesOtherCredits;
      const totalTaxAmountCollected = sumByWhen(transactions, 'taxAmount', t => t.type === 'CREDIT');
      const totalAmountPaidExpenses = sumByWhen(expenses, 'netAmountInHostCurrency');
      const totalHostFees = sumBy([...donations, ...otherCredits], 'hostFeeInHostCurrency');
      const totalNetAmountReceivedForCollectives = sumBy([...donations, ...otherCredits], 'netAmountInHostCurrency');
      const totalAmountSpent =
        totalAmountPaidExpenses +
        payoutProcessorFeesOther +
        payoutProcessorFeesPaypal +
        totalAmountOtherDebits +
        paymentProcessorFeesOtherDebits +
        platformFeesOtherDebits;

      const totalSharedRevenue = sumByWhen(
        donations,
        t => (t.hostFeeInHostCurrency * (t.data?.hostFeeSharePercent || plan.hostFeeSharePercent)) / 100,
        t => !t.platformFeeInHostCurrency && t.hostFeeInHostCurrency,
      );
      const hostNetRevenue = Math.abs(totalHostFees) + totalSharedRevenue;

      data.stats = {
        ...data.stats,
        ...stats,
        plan,
        numberDonations: donations.length,
        numberOtherCredits: otherCredits?.length || 0,
        numberOtherDebits: otherDebits?.length || 0,
        numberPaidExpenses: expenses.length,
        numberTransactions: transactions.length,
        paymentProcessorFees,
        paymentProcessorFeesOtherCredits,
        paymentProcessorFeesOtherDebits,
        payoutProcessorFeesOther,
        payoutProcessorFeesPaypal,
        payoutProcessorFeesTransferWise,
        platformFees,
        platformFeesOtherCredits,
        platformFeesOtherDebits,
        totalActiveCollectives: Object.keys(keyBy(data.transactions, 'CollectiveId')).length,
        totalAmountDonations,
        totalAmountOtherCredits,
        totalAmountOtherDebits,
        totalAmountPaidExpenses,
        totalAmountSpent,
        totalHostFees,
        totalNetAmountReceived,
        totalNetAmountReceivedForCollectives,
        totalTaxAmountCollected,
        totalSharedRevenue,
        hostNetRevenue,
      };

      summary.hosts.push({
        host: { name: host.name, slug: host.slug, currency: host.currency },
        stats: data.stats,
      });
      summary.totalActiveHosts++;
      summary.totalActiveCollectives += data.stats.totalActiveCollectives;
      summary.numberTransactions += data.stats.numberTransactions;
      summary.numberDonations += data.stats.numberDonations;
      summary.numberPaidExpenses += data.stats.numberPaidExpenses;
      summary.totalAmountPaidExpenses += data.stats.totalAmountPaidExpenses;
      // Don't send transactions in email if there is more than 1000
      if (data.transactions.length > 1000) {
        delete data.transactions;
      }
      const admins = await getHostAdminsEmails(host);
      await sendEmail(admins, data, attachments);
    } catch (e) {
      console.error(`Error in processing host ${host.slug}:`, e);
      debug(e);
    }
  };

  const sendEmail = (recipients, data, attachments) => {
    debug('Sending email to ', recipients);
    if (!recipients || recipients.length === 0) {
      console.error('Unable to send host report for ', data.host.slug, 'No recipient to send to');
      return;
    }
    debug('email data stats', JSON.stringify(data.stats, null, 2));
    const options = { attachments };
    return emailLib.send(emailTemplate, recipients, data, options);
  };

  const query = `
  with "hosts" as (SELECT DISTINCT "HostCollectiveId" AS id FROM "Collectives" WHERE "deletedAt" IS NULL AND "isActive" IS TRUE AND "HostCollectiveId" IS NOT NULL)
  SELECT c.* FROM "Collectives" c WHERE c.id IN (SELECT h.id FROM hosts h) ${previewCondition}
  `;

  const hosts = await sequelize.query(query, {
    model: models.Collective,
    type: sequelize.QueryTypes.SELECT,
  });
  console.log(`Preparing the ${reportName} for ${hosts.length} hosts`);

  return Promise.map(hosts, processHost, { concurrency: 1 }).then(() => {
    console.log('>>> All done. Exiting.');
    process.exit(0);
  });
}

export default HostReport;

import moment from 'moment';

import { SupportedCurrency } from '../constants/currencies';

import { getFxRate, roundCentsAmount } from './currency';
import { fillTimeSeriesWithNodes } from './utils';

async function calculateReportNode({ groups, startingBalanceByCurrency, currency, date }) {
  const startingBalance = (
    await Promise.all(
      Object.keys(startingBalanceByCurrency).map(async (c: SupportedCurrency) => {
        const fxRate = await getFxRate(c, currency, date);
        return roundCentsAmount(startingBalanceByCurrency[c] * fxRate, currency);
      }),
    )
  ).reduce((acc, balance) => acc + balance, 0);

  const groupsWithConvertedCurrency = await Promise.all(
    groups.map(async group => {
      const fxRate = await getFxRate(group.hostCurrency, currency, date);
      return {
        ...group,
        netAmount: {
          value: roundCentsAmount(group.netAmountInHostCurrency * fxRate, currency),
          currency,
        },
        amount: {
          value: roundCentsAmount(group.amountInHostCurrency * fxRate, currency),
          currency,
        },
        paymentProcessorFee: {
          value: roundCentsAmount(group.paymentProcessorFeeInHostCurrency * fxRate, currency),
          currency,
        },
        platformFee: {
          value: roundCentsAmount(group.platformFeeInHostCurrency * fxRate, currency),
          currency,
        },
        hostFee: {
          value: roundCentsAmount(group.hostFeeInHostCurrency * fxRate, currency),
          currency,
        },
        taxAmount: {
          value: roundCentsAmount(group.taxAmountInHostCurrency * fxRate, currency),
          currency,
        },
      };
    }),
  );

  const totalChange = groupsWithConvertedCurrency.reduce((acc, n) => acc + n.netAmount.value, 0);

  const endingBalanceByCurrency = groups.reduce((acc, group) => {
    const { hostCurrency, netAmountInHostCurrency } = group;
    acc[hostCurrency] = (acc[hostCurrency] || 0) + netAmountInHostCurrency;
    return acc;
  }, startingBalanceByCurrency);

  return {
    node: {
      date: date,
      startingBalance: { value: startingBalance, currency: currency },
      endingBalance: { value: startingBalance + totalChange, currency: currency },
      totalChange: { value: totalChange, currency: currency },
      groups: groupsWithConvertedCurrency,
    },
    endingBalanceByCurrency,
  };
}

export async function getHostReportNodesFromQueryResult({ queryResult, dateFrom, dateTo, timeUnit, currency }) {
  const resultsGroupedByPeriod = queryResult.reduce((acc, row) => {
    const date = moment.utc(row.date).toISOString();
    if (!acc[date]) {
      acc[date] = [];
    }
    acc[date].push(row);
    return acc;
  }, {});

  const nodes = Object.keys(resultsGroupedByPeriod).map(date => ({
    date,
    groups: resultsGroupedByPeriod[date],
  }));

  const continuousNodes = fillTimeSeriesWithNodes({
    nodes,
    initialData: { groups: [] },
    endDate: dateTo,
    timeUnit,
  });

  let managedBalanceByCurrency = {};
  let operationalBalanceByCurrency = {};

  const processedNodes = [];
  for (const node of continuousNodes) {
    const [managedFunds, operationalFunds] = await Promise.all([
      await calculateReportNode({
        groups: node.groups.filter(n => !n.isHost),
        startingBalanceByCurrency: managedBalanceByCurrency,
        currency,
        date: node.date,
      }),
      await calculateReportNode({
        groups: node.groups.filter(n => n.isHost),
        startingBalanceByCurrency: operationalBalanceByCurrency,
        currency,
        date: node.date,
      }),
    ]);

    operationalBalanceByCurrency = operationalFunds.endingBalanceByCurrency;
    managedBalanceByCurrency = managedFunds.endingBalanceByCurrency;

    processedNodes.push({
      date: node.date,
      managedFunds: managedFunds.node,
      operationalFunds: operationalFunds.node,
    });
  }

  // Filter nodes to only return the ones that are within the date range (we need them before this to calculate the correct balance)
  const filteredNodes = processedNodes.filter(n => {
    return (!dateFrom || moment(n.date).isSameOrAfter(dateFrom)) && (!dateTo || moment(n.date).isSameOrBefore(dateTo));
  });

  return filteredNodes.reverse(); // Return most recent node first
}

export async function getAccountReportNodesFromQueryResult({ queryResult, dateFrom, dateTo, timeUnit, currency }) {
  const resultsGroupedByPeriod = queryResult.reduce((acc, row) => {
    const date = moment.utc(row.date).toISOString();
    if (!acc[date]) {
      acc[date] = [];
    }
    acc[date].push(row);
    return acc;
  }, {});

  const nodes = Object.keys(resultsGroupedByPeriod).map(date => ({
    date,
    groups: resultsGroupedByPeriod[date],
  }));

  const continuousNodes = fillTimeSeriesWithNodes({
    nodes,
    initialData: { groups: [] },
    endDate: dateTo,
    timeUnit,
  });

  let balanceByCurrency = {};

  const processedNodes = [];
  for (const node of continuousNodes) {
    const result = await calculateReportNode({
      groups: node.groups,
      startingBalanceByCurrency: balanceByCurrency,
      currency,
      date: node.date,
    });

    balanceByCurrency = result.endingBalanceByCurrency;

    processedNodes.push(result.node);
  }

  // Filter nodes to only return the ones that are within the date range (we need them before this to calculate the correct balance)
  const filteredNodes = processedNodes.filter(n => {
    return (!dateFrom || moment(n.date).isSameOrAfter(dateFrom)) && (!dateTo || moment(n.date).isSameOrBefore(dateTo));
  });

  return filteredNodes.reverse(); // Return most recent node first
}

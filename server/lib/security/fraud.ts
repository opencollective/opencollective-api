import config from 'config';
import debugLib from 'debug';
import Express from 'express';
import { toLower, toString } from 'lodash';
import moment from 'moment';

import { ValidationFailed } from '../../graphql/errors';
import models, { sequelize } from '../../models';
import SuspendedAsset, { AssetType } from '../../models/SuspendedAsset';
import logger from '../logger';
import { ifStr } from '../utils';

const debug = debugLib('security/fraud');

type FraudStats = { errorRate: number; numberOfOrders: number; paymentMethodRate: number };

const BASE_STATS_QUERY = `
    SELECT
        ROUND(COALESCE(AVG(CASE WHEN o."status" = 'ERROR' THEN 1 ELSE 0 END), 0), 5)::Float as "errorRate",
        COUNT(*) as "numberOfOrders",
        COALESCE(COUNT(DISTINCT CONCAT(pm."name", pm."data"->>'expYear'))::Float / NULLIF(COUNT(*),0), 0) as "paymentMethodRate"
    FROM "Orders" o
    LEFT JOIN "PaymentMethods" pm ON pm."id" = o."PaymentMethodId"
`;

export const getUserStats = async (user: typeof models.User, since?: Date): Promise<FraudStats> => {
  return sequelize.query(
    `
    ${BASE_STATS_QUERY} 
    WHERE o."CreatedByUserId" = :userId
    AND pm."type" = 'creditcard'
    ${ifStr(since, 'AND o."createdAt" >= :since')}
    `,
    { replacements: { userId: user.id, since }, type: sequelize.QueryTypes.SELECT, raw: true, plain: true },
  );
};

export const getEmailStats = async (email: string, since?: Date): Promise<FraudStats> => {
  return sequelize.query(
    `
    ${BASE_STATS_QUERY} 
    LEFT JOIN "Users" u ON u."id" = o."CreatedByUserId"
    WHERE LOWER(u."email") LIKE LOWER(:email)
    AND pm."type" = 'creditcard'
    ${ifStr(since, 'AND o."createdAt" >= :since')}
    `,
    { replacements: { email, since }, type: sequelize.QueryTypes.SELECT, raw: true, plain: true },
  );
};

export const getIpStats = async (ip: string, since?: Date): Promise<FraudStats> => {
  return sequelize.query(
    `
    ${BASE_STATS_QUERY} 
    WHERE o."data"->>'reqIp' LIKE :ip
    AND pm."type" = 'creditcard'
    ${ifStr(since, 'AND o."createdAt" >= :since')}
    `,
    { replacements: { ip, since }, type: sequelize.QueryTypes.SELECT, raw: true, plain: true },
  );
};

export const getCreditCardStats = async (
  { name, expYear, expMonth, country }: { name: string; expYear: number; expMonth: number; country: string },
  since?: Date,
): Promise<FraudStats> => {
  return sequelize.query(
    `
    ${BASE_STATS_QUERY} 
    WHERE pm."type" = 'creditcard'
    AND pm."name" = :name
    AND pm."data"->>'expYear' = :expYear
    AND pm."data"->>'expMonth' = :expMonth
    AND pm."data"->>'country' = :country
    ${ifStr(since, 'AND o."createdAt" >= :since')}
    `,
    {
      replacements: { name, expYear: toString(expYear), expMonth: toString(expMonth), country, since },
      type: sequelize.QueryTypes.SELECT,
      raw: true,
      plain: true,
    },
  );
};

const makeStatLimitChecker = (stat: FraudStats) => (limitParams: number[]) => {
  const statArray = [stat.numberOfOrders, stat.errorRate, stat.paymentMethodRate];
  const fail = limitParams.every((limit, index) => limit <= statArray[index]);
  debug(`Checking ${statArray.join()} below treshold ${limitParams.join()}: ${fail ? 'FAIL' : 'PASS'}`);
  if (fail) {
    throw new Error(`Stat ${statArray.join()} above treshold ${limitParams.join()}`);
  }
};

export const validateStat = async (
  statFn: (...any) => Promise<FraudStats>,
  args: Parameters<typeof getUserStats | typeof getIpStats | typeof getEmailStats>,
  limitParamsString: string,
  errorMessage: string,
  options?: { onFail?: (error?: Error) => Promise<void>; preCheck?: () => Promise<void> },
) => {
  if (options?.preCheck) {
    await options.preCheck();
  }
  const stats = await statFn(...args);
  const assertLimit = makeStatLimitChecker(stats);
  const limitParams = JSON.parse(limitParamsString);
  try {
    limitParams.forEach(assertLimit);
  } catch (e) {
    const error = new ValidationFailed(`${errorMessage}: ${e.message}`, null, { stats, limitParams });
    logger.warn(error.message);
    options?.onFail?.(error).catch(logger.error);
    throw error;
  }
};

export const checkUser = (user: typeof models.User) => {
  const assetParams = { type: AssetType.USER, fingerprint: toString(user.id) };
  return validateStat(
    getUserStats,
    [user, moment.utc().subtract(1, 'month').toDate()],
    config.fraud.order.U1M,
    `Fraud: User #${user.id} failed fraud protection`,
    {
      onFail: async error => {
        await SuspendedAsset.create({
          ...assetParams,
          reason: error.message,
        });
        await user.limitAccount('User failed fraud protection.');
      },
      preCheck: async () => {
        await SuspendedAsset.assertAssetIsNotSuspended(assetParams);
      },
    },
  );
};

export const checkCreditCard = async (paymentMethod: {
  name: string;
  creditCardInfo?: { expYear: number; expMonth: number; country: string };
}) => {
  const { name, creditCardInfo } = paymentMethod;
  const assetParams = {
    type: AssetType.CREDIT_CARD,
    fingerprint: [name, ...Object.values(creditCardInfo)].join('-'),
  };
  return validateStat(
    getCreditCardStats,
    [{ name, ...creditCardInfo }, moment.utc().subtract(1, 'month').toDate()],
    config.fraud.order.C1M,
    `Fraud: Credit Card ${assetParams.fingerprint} failed fraud protection`,
    {
      onFail: async error => {
        await SuspendedAsset.create({
          ...assetParams,
          reason: error.message,
        });
      },
      preCheck: async () => {
        await SuspendedAsset.assertAssetIsNotSuspended(assetParams);
      },
    },
  );
};

export const checkIP = async (ip: string) => {
  const assetParams = { type: AssetType.IP, fingerprint: ip };
  return validateStat(
    getIpStats,
    [ip, moment.utc().subtract(5, 'days').toDate()],
    config.fraud.order.I5D,
    `Fraud: IP ${ip} failed fraud protection`,
    {
      onFail: async error => {
        await SuspendedAsset.create({
          ...assetParams,
          reason: error.message,
        });
      },
      preCheck: async () => {
        await SuspendedAsset.assertAssetIsNotSuspended(assetParams);
      },
    },
  );
};

export const checkEmail = async (email: string) => {
  const assetParams = { type: AssetType.EMAIL_ADDRESS, fingerprint: toLower(email) };
  return validateStat(
    getEmailStats,
    [email, moment.utc().subtract(1, 'month').toDate()],
    config.fraud.order.E1M,
    `Fraud: email ${email} failed fraud protection`,
    {
      onFail: async error => {
        await SuspendedAsset.create({
          ...assetParams,
          reason: error.message,
        });
      },
      preCheck: async () => {
        await SuspendedAsset.assertAssetIsNotSuspended(assetParams);
      },
    },
  );
};

export const orderFraudProtection = async (
  req: Express.Request,
  order: {
    [key: string]: unknown;
    guestInfo?: { email?: string };
    paymentMethod?: {
      type: string;
      name: string;
      creditCardInfo?: { expYear: number; expMonth: number; country: string };
    };
  },
) => {
  const { remoteUser, ip } = req;
  const checks = [];

  if (ip) {
    checks.push(checkIP(ip));
  }

  if (order.paymentMethod?.creditCardInfo) {
    checks.push(checkCreditCard(order.paymentMethod));
  }

  if (remoteUser) {
    checks.push(checkUser(remoteUser));
  } else if (order?.guestInfo?.email) {
    checks.push(checkEmail(order.guestInfo.email));
  }

  await Promise.all(checks);
};

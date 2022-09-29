import config from 'config';
import debugLib from 'debug';
import moment from 'moment';

import { ValidationFailed } from '../../graphql/errors';
import models, { sequelize } from '../../models';
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

export const getEmailStats = async (domain: string, since?: Date): Promise<FraudStats> => {
  return sequelize.query(
    `
    ${BASE_STATS_QUERY} 
    LEFT JOIN "Users" u ON u."id" = o."CreatedByUserId"
    WHERE LOWER(u."email") LIKE LOWER(:domain)
    AND pm."type" = 'creditcard'
    ${ifStr(since, 'AND o."createdAt" >= :since')}
    `,
    { replacements: { domain, since }, type: sequelize.QueryTypes.SELECT, raw: true, plain: true },
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
  options?: { onFail: () => Promise<void> },
) => {
  const stats = await statFn(...args);
  const assertLimit = makeStatLimitChecker(stats);
  const limitParams = JSON.parse(limitParamsString);
  try {
    limitParams.forEach(assertLimit);
  } catch (e) {
    const error = new ValidationFailed(`${errorMessage}: ${e.message}`, null, { stats, limitParams });
    logger.warn(error.message);
    options?.onFail?.().catch(logger.error);
    throw error;
  }
};

export const checkUser = (user: typeof models.User) =>
  validateStat(
    getUserStats,
    [user, moment.utc().subtract(1, 'month').toDate()],
    config.fraud.order.U1M,
    `Fraud: User #${user.id} failed fraud protection`,
    {
      onFail: async () => {
        await user.limitAccount('User failed fraud protection.');
      },
    },
  );

export const checkIP = async (ip: string) =>
  validateStat(
    getIpStats,
    [ip, moment.utc().subtract(5, 'days').toDate()],
    config.fraud.order.I5D,
    `Fraud: IP ${ip} failed fraud protection`,
  );

export const checkEmail = async (email: string) =>
  validateStat(
    getEmailStats,
    [email, moment.utc().subtract(1, 'month').toDate()],
    config.fraud.order.E1M,
    `Fraud: email ${email} failed fraud protection`,
  );

export const orderFraudProtection = async req => {
  const { remoteUser } = req;

  if (remoteUser) {
    await checkUser(remoteUser);
  }
};

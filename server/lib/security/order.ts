import config from 'config';
import debugLib from 'debug';
import Express from 'express';
import { pick, toLower, toString } from 'lodash';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import { ValidationFailed } from '../../graphql/errors';
import { sequelize } from '../../models';
import SuspendedAsset, { AssetType } from '../../models/SuspendedAsset';
import User from '../../models/User';
import logger from '../logger';
import { ifStr, parseToBoolean } from '../utils';

const debug = debugLib('security/fraud');

const ENFORCE_SUSPENDED_ASSET = parseToBoolean(config.fraud.enforceSuspendedAsset) === true;

type FraudStats = { errorRate: number; numberOfOrders: number; paymentMethodRate: number };

const BASE_STATS_QUERY = `
  SELECT
    ROUND(COALESCE(AVG(CASE WHEN o."status" = 'ERROR' THEN 1 ELSE 0 END), 0), 5)::Float as "errorRate",
    COUNT(*) as "numberOfOrders",
    COALESCE(
      COUNT(
        DISTINCT COALESCE(
          NULLIF(CONCAT(pm."name", pm."data"->>'expYear'), ''),
          pm."id"::TEXT
        )
      )::FLOAT / NULLIF(COUNT(*), 0),
      0
    ) as "paymentMethodRate"
  FROM "Orders" o
  LEFT JOIN "PaymentMethods" pm ON pm."id" = o."PaymentMethodId"
`;

export const getUserStats = async (user: User, interval?: string): Promise<FraudStats> => {
  return sequelize.query(
    `
    ${BASE_STATS_QUERY} 
    WHERE o."CreatedByUserId" = :userId
    AND o."deletedAt" IS NULL
    ${ifStr(interval, 'AND o."createdAt" >= NOW() - INTERVAL :interval')}
    `,
    { replacements: { userId: user.id, interval }, type: sequelize.QueryTypes.SELECT, raw: true, plain: true },
  );
};

export const getEmailStats = async (email: string, interval?: string): Promise<FraudStats> => {
  return sequelize.query(
    `
    ${BASE_STATS_QUERY} 
    LEFT JOIN "Users" u ON u."id" = o."CreatedByUserId"
    WHERE u."email" = LOWER(:email)
    AND o."deletedAt" IS NULL
    ${ifStr(interval, 'AND o."createdAt" >= NOW() - INTERVAL :interval')}
    `,
    { replacements: { email, interval }, type: sequelize.QueryTypes.SELECT, raw: true, plain: true },
  );
};

export const getIpStats = async (ip: string, interval?: string): Promise<FraudStats> => {
  return sequelize.query(
    `
    ${BASE_STATS_QUERY} 
    WHERE o."data"#>>'{reqIp}' = :ip
    AND o."deletedAt" IS NULL
    ${ifStr(interval, 'AND o."createdAt" >= NOW() - INTERVAL :interval')}
    `,
    { replacements: { ip, interval }, type: sequelize.QueryTypes.SELECT, raw: true, plain: true },
  );
};

export const getCreditCardStats = async (
  {
    name,
    expYear,
    expMonth,
    country,
    fingerprint,
  }: { name: string; expYear: number; expMonth: number; country: string; fingerprint: string },
  interval?: string,
): Promise<FraudStats> => {
  return sequelize.query(
    `
    ${BASE_STATS_QUERY} 
    WHERE 
    o."deletedAt" IS NULL
    AND pm."deletedAt" IS NULL
    AND pm."type" = 'creditcard'
    ${
      fingerprint
        ? `AND pm."data"#>>'{fingerprint}' = :fingerprint`
        : `AND pm."name" = :name AND pm."data"->>'expYear' = :expYear AND pm."data"->>'expMonth' = :expMonth AND pm."data"->>'country' = :country`
    }
    ${ifStr(interval, 'AND o."createdAt" >= NOW() - INTERVAL :interval')}
    `,
    {
      replacements: { name, expYear: toString(expYear), expMonth: toString(expMonth), country, interval, fingerprint },
      type: sequelize.QueryTypes.SELECT,
      raw: true,
      plain: true,
    },
  );
};

const makeStatLimitChecker =
  (statFn: (...any) => Promise<FraudStats>, args: Parameters<typeof statFn>) =>
  async (limitParams: [string, number, number, number]) => {
    const [interval, ...limits] = limitParams;
    args.push(interval);
    const stat = await statFn(...args);
    const statArray = [stat.numberOfOrders, stat.errorRate, stat.paymentMethodRate];
    const fail = limits.every((limit, index) => limit <= statArray[index]);
    debug(`Checking ${statArray.join()} below treshold ${limitParams.join()}: ${fail ? 'FAIL' : 'PASS'}`);
    if (fail) {
      throw new Error(`Stat ${statArray.join()} above treshold ${limitParams.join()}`);
    }
  };

type ValidateStatOptions = {
  onFail?: (error?: Error) => Promise<void>;
  preCheck?: () => Promise<void>;
  assetParams?: { type: AssetType; fingerprint: string };
};

export const validateStat = async (
  statFn: (...any) => Promise<FraudStats>,
  args: Parameters<typeof statFn>,
  limitParamsString: string,
  errorMessage: string,
  options: ValidateStatOptions = {},
) => {
  if (ENFORCE_SUSPENDED_ASSET && (options.assetParams || options.preCheck)) {
    const preCheck = options.preCheck?.() || SuspendedAsset.assertAssetIsNotSuspended(options.assetParams);
    await preCheck;
  }
  const assertLimit = makeStatLimitChecker(statFn, args);
  const limitParams = JSON.parse(limitParamsString);
  try {
    await Promise.all(limitParams.map(assertLimit));
  } catch (e) {
    const error = new ValidationFailed(`${errorMessage}: ${e.message}`, null, { args, limitParams });
    logger.warn(error.message);
    const onFail =
      options.onFail?.(error) ||
      SuspendedAsset.create({
        ...options.assetParams,
        reason: error.message,
      });
    await onFail.catch(logger.error);
    if (ENFORCE_SUSPENDED_ASSET) {
      throw error;
    }
  }
};

export const checkUser = (user: User) => {
  const assetParams = { type: AssetType.USER, fingerprint: toString(user.id) };
  return validateStat(
    getUserStats,
    [user],
    config.fraud.order.user,
    `Fraud: User #${user.id} failed fraud protection`,
    {
      assetParams,
      onFail: async error => {
        await SuspendedAsset.create({
          ...assetParams,
          reason: error.message,
        });
        // await user.limitAccount('User failed fraud protection.');
      },
    },
  );
};

export const checkCreditCard = async (paymentMethod: {
  name: string;
  type: string;
  data?: { expYear: number; expMonth: number; brand?: string; fingerprint?: string };
}) => {
  const { name, data } = paymentMethod;
  const assetParams = {
    type: AssetType.CREDIT_CARD,
    fingerprint:
      data.fingerprint || [name, ...Object.values(pick(data, ['brand', 'expMonth', 'expYear', 'funding']))].join('-'),
  };

  return validateStat(
    getCreditCardStats,
    [{ name, ...data }],
    config.fraud.order.card,
    `Fraud: Credit Card ${assetParams.fingerprint} failed fraud protection`,
    { assetParams },
  );
};

export const checkIP = async (ip: string) => {
  const assetParams = { type: AssetType.IP, fingerprint: ip };
  return validateStat(getIpStats, [ip], config.fraud.order.ip, `Fraud: IP ${ip} failed fraud protection`, {
    assetParams,
  });
};

export const checkEmail = async (email: string) => {
  const assetParams = { type: AssetType.EMAIL_ADDRESS, fingerprint: toLower(email) };
  return validateStat(
    getEmailStats,
    [email],
    config.fraud.order.email,
    `Fraud: email ${email} failed fraud protection`,
    {
      assetParams,
    },
  );
};

export const orderFraudProtection = async (
  req: Express.Request,
  order: {
    guestInfo?: { email?: string };
    paymentMethod?: {
      type: PAYMENT_METHOD_TYPE;
      service: PAYMENT_METHOD_SERVICE;
      name: string;
      data?: { expYear: number; expMonth: number; brand?: string; fingerprint?: string };
    };
  },
) => {
  const { remoteUser, ip } = req;
  const checks = [];

  if (ip) {
    checks.push(checkIP(ip));
  }

  if (
    order.paymentMethod?.type === PAYMENT_METHOD_TYPE.CREDITCARD &&
    order.paymentMethod?.service === PAYMENT_METHOD_SERVICE.STRIPE
  ) {
    checks.push(checkCreditCard(order.paymentMethod));
  }

  if (remoteUser) {
    checks.push(checkUser(remoteUser));
  } else if (order.guestInfo?.email) {
    checks.push(checkEmail(order.guestInfo.email));
  }

  await Promise.all(checks);
};

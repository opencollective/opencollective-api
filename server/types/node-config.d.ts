import type { Util } from 'config/lib/util';

import type DefaultConfig from '../../config/default.json';

type AppConfig = Omit<
  DefaultConfig,
  'platform' | 'slack' | 'opensearch' | 'host' | 'exports' | 'graphql' | 'activities' | 'services' | 'database'
> & {
  env?: string;
  platform?: {
    collectiveId?: string;
    userId?: string;
    currency?: string;
    address?: string;
    country?: string;
    name?: string;
  };
  slack?: {
    webhooks?: {
      abuse?: string | null;
      engineeringAlerts?: string | null;
    };
  };
  host?: DefaultConfig['host'] & {
    frontend?: string;
    webhooks?: string;
  };
  opensearch?: DefaultConfig['opensearch'] & {
    url?: string;
    indexesPrefix?: string;
  };
  exports?: DefaultConfig['exports'] & {
    concurrency?: number;
  };
  graphql?: DefaultConfig['graphql'] & {
    apollo?: {
      key?: string;
      graphRef?: string;
    };
    rejectOnMaxComplexity?: boolean;
  };
  activities?: DefaultConfig['activities'] & {
    legacyTransactionsCollectiveIds?: string;
  };
  services?: DefaultConfig['services'] & {
    exports?: boolean;
  };
  database?: DefaultConfig['database'] & {
    logQueryOrigin?: boolean;
    override?: {
      database?: string;
      username?: string;
      password?: string;
      host?: string;
      port?: string;
    };
  };
  fixer?: {
    accessKey?: string;
    disableMock?: boolean | string;
  };
  gocardless?: {
    secretId?: string;
    secretKey?: string;
    env?: string;
  };
  mailgun?: {
    user?: string;
    password?: string;
    apiKey?: string;
  };
  memcache?: {
    servers?: string;
    username?: string;
    password?: string;
  };
  redis?: {
    serverUrl?: string;
    serverUrlTimeline?: string;
    serverUrlSession?: string;
  };
  turnstile?: {
    secretKey?: string;
    sitekey?: string;
  };
  cloudflare?: {
    key?: string;
    email?: string;
    zone?: string;
  };
};

type OpenCollectiveConfig = AppConfig & {
  util: Util;
  get<T>(property: string): T;
  has(property: string): boolean;
};

declare const config: OpenCollectiveConfig;
export = config;

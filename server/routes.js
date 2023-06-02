import { ApolloArmor } from '@escape.tech/graphql-armor';
import { ApolloServer } from 'apollo-server-express';
import config from 'config';
import graphqlUploadExpress from 'graphql-upload/graphqlUploadExpress.js';
import { get, pick } from 'lodash';
import multer from 'multer';

import * as connectedAccounts from './controllers/connectedAccounts';
import * as gitbook from './controllers/gitbook';
import helloworks from './controllers/helloworks';
import uploadImage from './controllers/images';
import * as email from './controllers/services/email';
import * as transferwise from './controllers/transferwise';
import * as users from './controllers/users';
import { paypalWebhook, stripeWebhook, thegivingblockWebhook, transferwiseWebhook } from './controllers/webhooks';
import { getGraphqlCacheProperties } from './graphql/cache';
import graphqlSchemaV1 from './graphql/v1/schema';
import graphqlSchemaV2 from './graphql/v2/schema';
import cache from './lib/cache';
import errors from './lib/errors';
import expressLimiter from './lib/express-limiter';
import logger from './lib/logger';
import oauth, { authorizeAuthenticateHandler } from './lib/oauth';
import { createRedisClient } from './lib/redis';
import { HandlerType, reportMessageToSentry, SentryGraphQLPlugin, sentryHandleSlowRequests } from './lib/sentry';
import { parseToBoolean } from './lib/utils';
import * as authentication from './middleware/authentication';
import errorHandler from './middleware/error_handler';
import * as params from './middleware/params';
import required from './middleware/required_param';
import sanitizer from './middleware/sanitizer';

const upload = multer();

const noCache = (req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  next();
};

export default async app => {
  /**
   * Extract GraphQL API Key
   */
  app.use('/graphql/:version?/:apiKey?', (req, res, next) => {
    req.isGraphQL = true; // Helps identify that the request is handled by GraphQL
    req.apiKey = req.params.apiKey;
    next();
  });

  app.use('*', authentication.checkPersonalToken);

  app.use('*', authentication.authorizeClient);

  // Setup rate limiter
  const redisClient = await createRedisClient();
  if (redisClient) {
    const expressLimiterOptions = {
      lookup: function (req, res, opts, next) {
        if (req.personalToken) {
          opts.lookup = 'personalToken.id';
          // 100 requests / minute for registered API Key
          opts.total = 100;
          opts.expire = 1000 * 60;
        } else if (req.remoteUser) {
          opts.lookup = 'remoteUser.id';
          // 100 requests / minute for authenticated users
          opts.total = 100;
          opts.expire = 1000 * 60;
        } else {
          opts.lookup = 'ip';
          // 10 requests / minute / ip for anonymous requests
          opts.total = 10;
          opts.expire = 1000 * 60;
        }
        return next();
      },
      whitelist: function (req) {
        const apiKey = req.query.api_key || req.body.api_key;
        // No limit with internal API Key
        return apiKey === config.keys.opencollective.apiKey;
      },
      onRateLimited: function (req, res) {
        let message;
        if (req.personalToken) {
          message = 'Rate limit exceeded. Contact-us to get higher limits.';
        } else {
          message = 'Rate limit exceeded. Create a Personal Token to get higher limits.';
        }
        res.status(429).send({ error: { message } });
      },
    };

    if (redisClient) {
      app.use('/graphql', expressLimiter(redisClient)(expressLimiterOptions));
    }
  }

  /**
   * Sign In related features
   */
  app.post('/users/signin', required('user'), users.signin);
  // check JWT and update token if no 2FA, but send back 2FA JWT if there is 2FA enabled
  app.post('/users/update-token', authentication.mustBeLoggedIn, users.exchangeLoginToken); // deprecated
  app.post('/users/exchange-login-token', authentication.mustBeLoggedIn, users.exchangeLoginToken);
  // check JWT and send an extended JWT back
  app.post('/users/refresh-token', authentication.mustBeLoggedIn, users.refreshToken);
  // check the 2FA code against the token in the db to let 2FA-enabled users log in
  app.post('/users/two-factor-auth', authentication.mustBeLoggedIn, users.twoFactorAuthAndUpdateToken);

  /**
   * Moving forward, all requests will try to authenticate the user if there is a JWT token provided
   * (an error will be returned if the JWT token is invalid, if not present it will simply continue)
   */
  app.use('*', authentication.authenticateUser); // populate req.remoteUser if JWT token provided in the request

  // OAuth server (after authentication/JWT handling, at least for authorize)
  app.oauth = oauth;
  app.post('/oauth/token', noCache, app.oauth.token());
  app.post(
    '/oauth/authorize',
    noCache,
    app.oauth.authorize({ allowEmptyState: true, authenticateHandler: authorizeAuthenticateHandler }),
  );
  app.post('/oauth/authenticate', noCache, app.oauth.authenticate());

  /**
   * Parameters.
   */
  app.param('uuid', params.uuid);
  app.param('userid', params.userid);
  app.param('collectiveid', params.collectiveid);
  app.param('transactionuuid', params.transactionuuid);
  app.param('paranoidtransactionid', params.paranoidtransactionid);
  app.param('expenseid', params.expenseid);

  const isDevelopment = config.env === 'development';

  /**
   * GraphQL caching
   */
  app.use('/graphql', async (req, res, next) => {
    req.startAt = req.startAt || new Date();
    const { cacheKey, cacheSlug } = getGraphqlCacheProperties(req) || {}; // Returns null if not cacheable (e.g. if logged in)
    const enabled = parseToBoolean(config.graphql.cache.enabled);
    if (cacheKey && enabled) {
      const fromCache = await cache.get(cacheKey);
      if (fromCache) {
        // Track all slow queries on Sentry performance
        res.servedFromGraphqlCache = true;
        req.endAt = req.endAt || new Date();
        const executionTime = req.endAt - req.startAt;
        sentryHandleSlowRequests(executionTime);
        res.set('Execution-Time', executionTime);
        res.set('GraphQL-Cache', 'HIT');
        res.send(fromCache);
        return;
      }
      res.set('GraphQL-Cache', 'MISS');
      req.cacheKey = cacheKey;
      req.cacheSlug = cacheSlug;
    }
    next();
  });

  /**
   * GraphQL scope
   */
  app.use('/graphql/v1', async (req, res, next) => {
    // 1) We don't have proper "scope" handling in GraphQL v1, easy call is to restrict for OAuth
    // 2) GraphQL v1 is not officially supported and should not be used by third party developers
    if (req.userToken && req.userToken.type === 'OAUTH') {
      // We need exceptions for prototype and internal tools
      if (!req.userToken.client?.data?.enableGraphqlV1) {
        const errorMessage = 'OAuth access tokens are not accepted on GraphQL v1';
        logger.warn(errorMessage);
        return next(new errors.Unauthorized(errorMessage));
      }
    }

    if (req.personalToken) {
      logger.warn(`Personal Token using GraphQL v1: ${req.personalToken.id}`);
    }
    next();
  });

  /* GraphQL server protection rules */
  const logRejection = (ctx, err) => {
    let queryName = 'Query';
    if (ctx._ast) {
      const operation = ctx._ast.definitions?.find(d => d.kind === 'OperationDefinition');
      queryName = operation?.name?.value || queryName;
      reportMessageToSentry('Query complexity is too high', {
        handler: HandlerType.GQL,
        severity: 'warning',
        transactionName: `GraphQL complexity too high: ${queryName}`,
        extra: {
          query: ctx._ast.loc?.source?.body || '',
          message: err.message,
        },
      });
    }

    logger.warn(`Query complexity is too high (${queryName}): ${err.message.replace(/^Syntax Error: /, '')}`);
  };

  const apolloArmor = new ApolloArmor({
    // Depth is the number of nested fields in a query
    maxDepth: {
      onReject: [logRejection],
      propagateOnRejection: false,
      n: 15, // Currently identified max: 13 in contribution flow
    },
    // Cost is computed by the complexity plugin, it's a mix of the number of fields and the complexity of each field
    costLimit: {
      onReject: [logRejection],
      ignoreIntrospection: true,
      propagateOnRejection: false,
      maxCost: 12500, // Currently identified max: around 10000 on the PDF service (transaction receipt), around 7500 on expense form
    },
    // Tokens are the number of fields in a query
    maxTokens: {
      onReject: [logRejection],
      propagateOnRejection: false,
      n: 1000, // Currently identified max: 805 in the expense flow
    },
    maxAliases: { enabled: false }, // Not clear what value this adds
    maxDirectives: { enabled: false }, // Not clear what value this adds
    blockFieldSuggestion: { enabled: false }, // Our schema is public, no need to hide fields
  });

  const graphqlProtection = apolloArmor.protect();
  const graphqlPlugins = [...graphqlProtection.plugins];

  /* GraphQL server generic options */
  if (config.sentry?.dsn) {
    graphqlPlugins.push(SentryGraphQLPlugin);
  }

  const minExecutionTimeToCache = parseInt(config.graphql.cache.minExecutionTimeToCache);

  const graphqlServerOptions = {
    introspection: true,
    persistedQueries: false,
    playground: isDevelopment,
    csrfPrevention: { requestHeaders: ['Authorization'] },
    ...graphqlProtection,
    debug: !['production', 'staging'].includes(config.env), // Keep stracktraces in dev & CI
    plugins: graphqlPlugins,
    // Align with behavior from express-graphql
    context: ({ req }) => {
      return req;
    },
    formatError: err => {
      logger.error(`GraphQL error: ${err.message}`);
      const extra = pick(err, ['locations', 'path']);
      if (Object.keys(extra).length) {
        logger.error(JSON.stringify(extra));
      }

      const stacktrace = get(err, 'extensions.exception.stacktrace');
      if (stacktrace) {
        logger.error(stacktrace);
      }
      return err;
    },
    formatResponse: (response, ctx) => {
      const req = ctx.context;
      req.endAt = req.endAt || new Date();
      const executionTime = req.endAt - req.startAt;
      req.res.set('Execution-Time', executionTime);

      // Track all slow queries on Sentry performance
      sentryHandleSlowRequests(executionTime);

      // This will never happen for logged-in users as cacheKey is not set
      if (req.cacheKey && !response?.errors && executionTime > minExecutionTimeToCache) {
        cache.set(req.cacheKey, response, Number(config.graphql.cache.ttl));
        // Index key
        cache.get(`graphqlCacheKeys_${req.cacheSlug}`).then(keys => {
          keys = keys || [];
          keys.push(req.cacheKey);
          cache.set(`graphqlCacheKeys_${req.cacheSlug}`, keys);
        });
      }

      return response;
    },
  };

  app.use('/graphql', graphqlUploadExpress());

  /**
   * GraphQL v1
   */
  const graphqlServerV1 = new ApolloServer({
    schema: graphqlSchemaV1,
    ...graphqlServerOptions,
  });

  await graphqlServerV1.start();

  graphqlServerV1.applyMiddleware({ app, path: '/graphql/v1' });

  /**
   * GraphQL v2
   */
  const graphqlServerV2 = new ApolloServer({
    schema: graphqlSchemaV2,
    ...graphqlServerOptions,
  });

  await graphqlServerV2.start();

  graphqlServerV2.applyMiddleware({ app, path: '/graphql/v2' });

  /**
   * GraphQL default (v2)
   */
  graphqlServerV2.applyMiddleware({ app, path: '/graphql' });

  /**
   * Webhooks that should bypass api key check
   */
  app.post('/webhooks/stripe', stripeWebhook); // when it gets a new subscription invoice
  app.post('/webhooks/transferwise', transferwiseWebhook); // when it gets a new subscription invoice
  app.post('/webhooks/paypal/:hostId?', paypalWebhook);
  app.post('/webhooks/thegivingblock', thegivingblockWebhook);
  app.get('/connected-accounts/:service/callback', noCache, authentication.authenticateServiceCallback); // oauth callback
  app.delete(
    '/connected-accounts/:service/disconnect/:collectiveId',
    noCache,
    authentication.authenticateServiceDisconnect,
  );

  /**
   * Contact Form
   */
  app.post('/contact/send-message', email.messageSupport);

  app.use(sanitizer()); // note: this break /webhooks/mailgun /graphiql

  /**
   * Users.
   */
  app.get('/users/exists', required('email'), users.exists); // Checks the existence of a user based on email.

  /**
   * Separate route for uploading images to S3
   */
  app.post('/images', upload.single('file'), uploadImage);

  /**
   * Generic OAuth (ConnectedAccounts)
   */
  app.get('/connected-accounts/:service(github|transferwise)', noCache, authentication.authenticateService); // backward compatibility
  app.get(
    '/connected-accounts/:service(github|twitter|stripe|paypal|transferwise)/oauthUrl',
    noCache,
    authentication.authenticateService,
  );
  app.get('/connected-accounts/:service/verify', noCache, connectedAccounts.verify);

  /* TransferWise OTT Request Endpoint */
  app.post('/services/transferwise/pay-batch', noCache, transferwise.payBatch);

  /**
   * External services
   */
  app.get('/services/email/unsubscribe/:email/:slug/:type/:token', email.unsubscribe);

  /**
   * Github API - fetch all repositories using the user's access_token
   */
  app.get('/github-repositories', connectedAccounts.fetchAllRepositories); // used in Frontend by createCollective "GitHub flow"

  /**
   * Hello Works API - Helloworks hits this endpoint when a document has been completed.
   */
  app.post('/helloworks/callback', helloworks.callback);

  /**
   * Gitbook Search API
   */
  app.get('/docs/search', gitbook.search);

  /**
   * An endpoint to easily test Sentry integration
   */
  app.get('/__test_sentry__', (req, res) => {
    reportMessageToSentry('Testing sentry', { severity: 'debug', user: req.remoteUser });
    res.sendStatus(200);
  });

  /**
   * Override default 404 handler to make sure to obfuscate api_key visible in URL
   */
  app.use((req, res) => res.sendStatus(404));

  /**
   * Error handler.
   */
  app.use(errorHandler);
};

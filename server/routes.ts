import http from 'http';

import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { expressMiddleware } from '@as-integrations/express5';
import { ApolloArmor } from '@escape.tech/graphql-armor';
import config from 'config';
import type express from 'express';
import { print as convertASTToString } from 'graphql';
import graphqlUploadExpress from 'graphql-upload/graphqlUploadExpress.js';
import { get, pick } from 'lodash';
import multer from 'multer';

import * as connectedAccounts from './controllers/connectedAccounts';
import * as filesController from './controllers/files';
import * as gitbook from './controllers/gitbook';
import uploadImage from './controllers/images';
import LegalDocumentsController from './controllers/legal-documents';
import * as email from './controllers/services/email';
import * as transferwise from './controllers/transferwise';
import * as users from './controllers/users';
import { paypalWebhook, plaidWebhook, stripeWebhook, transferwiseWebhook } from './controllers/webhooks';
import { getGraphqlCacheProperties } from './graphql/cache';
import graphqlSchemaV1 from './graphql/v1/schema';
import graphqlSchemaV2 from './graphql/v2/schema';
import { apolloSlowRequestCachePlugin, apolloSlowResolverDebugPlugin, apolloStudioUsagePlugin } from './lib/apollo';
import cache from './lib/cache';
import errors from './lib/errors';
import expressLimiter from './lib/express-limiter';
import logger from './lib/logger';
import { withTiming } from './lib/middleware-timing';
import oauth, { authorizeAuthenticateHandler } from './lib/oauth';
import { createRedisClient, RedisInstanceType } from './lib/redis';
import { HandlerType, reportMessageToSentry, SentryGraphQLPlugin } from './lib/sentry';
import { checkIfSentryConfigured } from './lib/sentry/init';
import { parseToBoolean } from './lib/utils';
import * as authentication from './middleware/authentication';
import errorHandler from './middleware/error-handler';
import required from './middleware/required-param';
import sanitizer from './middleware/sanitizer';

const upload = multer();

const noCache = (req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  next();
};

export default async (app: express.Application) => {
  /**
   * Extract GraphQL API Key
   */
  app.use('/graphql{/:version}{/:apiKey}', (req, res, next) => {
    req.isGraphQL = true; // Helps identify that the request is handled by GraphQL
    const params = req.params as Record<string, string | undefined>;
    req.apiKey = params.apiKey;
    next();
  });

  app.use(withTiming('checkPersonalToken', authentication.checkPersonalToken));

  app.use(withTiming('authorizeClient', authentication.authorizeClient));

  /**
   * Sign In related features
   */
  app.post('/users/signin', required('user'), users.signin);
  app.post('/users/signup', users.signup);
  app.post('/users/resend-otp', users.resendEmailVerificationOTP);
  app.post('/users/verify-email', users.verifyEmail);
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
  app.use(withTiming('authenticateUser', authentication.authenticateUser)); // populate req.remoteUser if JWT token provided in the request

  // OAuth server (after authentication/JWT handling, at least for authorize)
  app['oauth'] = oauth;
  app.post('/oauth/token', noCache, app['oauth'].token());
  app.post(
    '/oauth/authorize',
    noCache,
    app['oauth'].authorize({ allowEmptyState: true, authenticateHandler: authorizeAuthenticateHandler }),
  );
  app.post('/oauth/authenticate', noCache, app['oauth'].authenticate());

  // Setup rate limiter
  // TODO: move to RedisInstanceType.SESSION ?
  const redisClient = await createRedisClient(RedisInstanceType.DEFAULT);
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

    app.use('/graphql', expressLimiter(redisClient)(expressLimiterOptions));
  }

  /**
   * GraphQL caching
   */
  if (parseToBoolean(config.graphql.cache.enabled)) {
    app.use(
      '/graphql',
      withTiming('graphqlCache', async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        req.startAt = req.startAt || new Date();
        const { cacheKey, cacheSlug } = getGraphqlCacheProperties(req) || {}; // Returns null if not cacheable (e.g. if logged in)
        if (cacheKey) {
          const fromCache = await cache.get(cacheKey);
          if (fromCache) {
            res.servedFromGraphqlCache = true;
            req.endAt = req.endAt || new Date();
            const executionTime = req.endAt.getTime() - req.startAt.getTime();
            res.set('Execution-Time', String(executionTime));
            res.set('GraphQL-Cache', 'HIT');
            res.send(fromCache);
            return;
          }
          res.set('GraphQL-Cache', 'MISS');
          req.cacheKey = cacheKey;
          req.cacheSlug = cacheSlug;
        }
        next();
      }),
    );
  }

  /**
   * GraphQL scope
   */
  app.use(
    '/graphql/v1',
    withTiming('graphqlScope', async (req, res, next) => {
      // 1) We don't have proper "scope" handling in GraphQL v1, easy call is to restrict for OAuth
      // 2) GraphQL v1 is not officially supported and should not be used by third party developers
      if (req.userToken && req.userToken.type === 'OAUTH') {
        // We need exceptions for prototype and internal tools
        if (!req.userToken.application?.data?.enableGraphqlV1) {
          const errorMessage = 'OAuth access tokens are not accepted on GraphQL v1';
          logger.warn(errorMessage);
          return next(new errors.Unauthorized(errorMessage));
        }
      }

      if (req.personalToken) {
        if (req.personalToken.data?.allowGraphQLV1) {
          logger.warn(`Personal Token using GraphQL v1: ${req.personalToken.id}`);
        } else {
          return next(new errors.Unauthorized('Personal Tokens are not accepted on GraphQL v1'));
        }
      }
      next();
    }),
  );

  /*
   * GraphQL server protection rules
   * @param {ValidationContext} ctx
   * @param {GraphQLError} err
   */
  const getGraphQLComplexityRejectionLogger = checkName => (ctx, err) => {
    let queryName = 'Query';
    const document = ctx?.getDocument();
    const operation = document?.definitions?.find(d => d.kind === 'OperationDefinition');
    queryName = get(operation, 'name.value') || queryName;
    reportMessageToSentry(`Query complexity is too high (${checkName})`, {
      handler: HandlerType.GQL,
      severity: 'warning',
      transactionName: `GraphQL complexity too high (${checkName}): ${queryName}`,
      extra: {
        message: err.message,
        body: document?.loc?.source?.body || '',
        query: document ? convertASTToString(document) : '',
      },
    });
  };

  const apolloArmor = new ApolloArmor({
    // Depth is the number of nested fields in a query
    maxDepth: {
      onReject: [getGraphQLComplexityRejectionLogger('maxDepth')],
      n: 20, // Currently identified max: 13 in contribution flow
      enabled: true,
    },
    // Cost is computed by the complexity plugin, it's a mix of the number of fields and the complexity of each field
    costLimit: {
      onReject: [getGraphQLComplexityRejectionLogger('costLimit')],
      ignoreIntrospection: true,
      propagateOnRejection: parseToBoolean(config.graphql.rejectOnMaxComplexity),
      maxCost: 130_000, // Currently identified max: around 125899 on the "ExpenseFormSchema" mutation
    },
    // Tokens are the number of fields in a query
    maxTokens: {
      onReject: [getGraphQLComplexityRejectionLogger('maxTokens')],
      propagateOnRejection: parseToBoolean(config.graphql.rejectOnMaxComplexity),
      n: 1500, // ExpensePage query
      enabled: true,
    },
    maxAliases: {
      onReject: [getGraphQLComplexityRejectionLogger('maxAliases')],
      enabled: true,
      n: 100,
    },
    maxDirectives: {
      onReject: [getGraphQLComplexityRejectionLogger('maxDirectives')],
      enabled: true,
      n: 100,
    },
    // Our schema is public, no need to hide fields
    blockFieldSuggestion: { enabled: false },
  });

  const httpServer = http.createServer(app);

  const graphqlProtection = apolloArmor.protect();

  const graphqlPlugins = [
    ...graphqlProtection.plugins,
    ApolloServerPluginDrainHttpServer({ httpServer }),
    apolloSlowRequestCachePlugin,
    apolloSlowResolverDebugPlugin,
    apolloStudioUsagePlugin,
  ];

  // /* GraphQL server generic options */
  if (checkIfSentryConfigured()) {
    graphqlPlugins.push(SentryGraphQLPlugin);
  }

  const apolloServerOptions = {
    includeStacktraceInErrorResponses: config.env !== 'production',
    // https://www.apollographql.com/docs/apollo-server/api/apollo-server#introspection
    introspection: true,
    // https://www.apollographql.com/docs/apollo-server/api/apollo-server#persistedqueries
    persistedQueries: false as const,
    // https://www.apollographql.com/docs/apollo-server/api/apollo-server#csrfprevention
    csrfPrevention: { requestHeaders: ['Authorization'] },
    // https://www.apollographql.com/docs/apollo-server/api/apollo-server#formaterror
    formatError: (formattedError, error) => {
      logger.error(`GraphQL error: ${formattedError.message}`);
      const extra = pick(formattedError, ['locations', 'path']);
      if (Object.keys(extra).length) {
        logger.error(JSON.stringify(extra));
      }

      const stacktrace = get(formattedError, 'extensions.exception.stacktrace');
      if (stacktrace) {
        logger.error(stacktrace);
      }

      if (parseToBoolean(config.graphql.error.detailed)) {
        /* eslint-disable no-console */
        console.log(formattedError);
        console.log(error);
        /* eslint-enable no-console */
      }

      return formattedError;
    },
    ...graphqlProtection,
    plugins: graphqlPlugins,
  };

  const apolloExpressMiddlewareOptions = {
    // Align with behavior from previously used `express-graphql` package
    context: async ({ req }) => {
      return req;
    },
  };

  app.use('/graphql', graphqlUploadExpress());

  /**
   * GraphQL v1
   */
  const graphqlServerV1 = new ApolloServer({
    schema: graphqlSchemaV1,
    ...apolloServerOptions,
  });

  await graphqlServerV1.start();

  app.use('/graphql/v1', expressMiddleware(graphqlServerV1, apolloExpressMiddlewareOptions));

  /**
   * GraphQL v2
   */
  const graphqlServerV2 = new ApolloServer({
    schema: graphqlSchemaV2,
    ...apolloServerOptions,
  });

  await graphqlServerV2.start();

  app.use('/graphql/v2', expressMiddleware(graphqlServerV2, apolloExpressMiddlewareOptions));

  /**
   * GraphQL default (v2)
   */
  app.use('/graphql', expressMiddleware(graphqlServerV2, apolloExpressMiddlewareOptions));

  /**
   * Generic OAuth (ConnectedAccounts)
   * To keep in sync with opencollective-frontend/pages/api/connected-accounts/[service]/oauthUrl.js
   */
  const oauthServiceAllowlist = new Set(['github', 'stripe', 'transferwise']);

  /**
   * Webhooks that should bypass api key check
   */
  app.post('/webhooks/stripe', stripeWebhook); // when it gets a new subscription invoice
  app.post('/webhooks/transferwise', transferwiseWebhook); // when it gets a new subscription invoice
  app.post('/webhooks/paypal{/:hostId}', paypalWebhook);
  app.post('/webhooks/plaid', plaidWebhook);
  app.get('/connected-accounts/:service/callback', noCache, (req, res, next) => {
    if (!oauthServiceAllowlist.has(req.params.service)) {
      return next(new errors.NotFound('Service not supported'));
    }
    return authentication.authenticateServiceCallback(req, res, next);
  }); // oauth callback
  app.delete(
    '/connected-accounts/:service/disconnect/:collectiveId',
    noCache,
    authentication.authenticateServiceDisconnect,
  );

  /**
   * Contact Form
   */
  app.post('/contact/send-message', email.messageSupport);

  // TODO: This sanitizer only applies to the routes below. It uses sanitize-html & some custom logic to remove all HTML tags.
  // It's not a good idea to use it globally, as it can break some routes that expect HTML content. We should aim at removing it.
  app.use(withTiming('sanitizer', sanitizer())); // note: this break /webhooks/mailgun /graphiql

  /**
   * Users.
   */
  app.get('/users/exists', required('email'), users.exists); // Checks the existence of a user based on email.

  /**
   * Separate route for uploading images to S3
   */
  app.post('/images', upload.single('file'), uploadImage);

  // backward compatibility
  app.get('/connected-accounts/:service', noCache, (req, res, next) => {
    if (!oauthServiceAllowlist.has(req.params.service)) {
      return next(new errors.NotFound('Service not supported'));
    }
    return authentication.authenticateService(req, res, next);
  });
  app.get('/connected-accounts/:service/oauthUrl', noCache, (req, res, next) => {
    if (!oauthServiceAllowlist.has(req.params.service)) {
      return next(new errors.NotFound('Service not supported'));
    }
    return authentication.authenticateService(req, res, next);
  });
  app.get('/connected-accounts/:service/verify', noCache, connectedAccounts.verify);

  /* TransferWise OTT Request Endpoint */
  app.post('/services/transferwise/pay-batch', noCache, transferwise.payBatch);

  /**
   * External services
   */
  app.get('/services/email/unsubscribe/:email/:slug/:type/:token', email.unsubscribe); // When users click on the unsubscribe link in the email
  app.post('/services/email/unsubscribe/:email/:slug/:type/:token', email.unsubscribe); // For compatibility with the `List-Unsubscribe-Post` header

  /**
   * Github API - fetch all repositories using the user's access_token
   */
  app.get('/github-repositories', connectedAccounts.fetchAllRepositories); // used in Frontend by createCollective "GitHub flow"

  /**
   * File downloads
   */
  app.get('/legal-documents/:id/download', LegalDocumentsController.download as any);
  app.get('/files/:uploadedFileId', filesController.getFile as any);

  /**
   * Gitbook Search API
   */
  app.get('/docs/search', gitbook.search);

  /**
   * Status endpoint
   */
  const statusHandler = (req: express.Request, res: express.Response) => {
    res.json({
      status: 'ok',
      authenticated: Boolean(req.remoteUser && req.remoteUser.id),
    });
  };

  app.get('/status', statusHandler);
  app.post('/status', statusHandler);

  /**
   * An endpoint to easily test Sentry integration
   */
  app.get('/__test_sentry__', (req, res) => {
    reportMessageToSentry('Testing sentry', { severity: 'debug', user: req.remoteUser });
    res.sendStatus(200);
  });

  app.get('/__test_sentry_crash__', () => {
    throw new Error('Test Sentry');
  });

  /**
   * Override default 404 handler to make sure to obfuscate api_key visible in URL
   */
  function simple404Middleware(_req, res: express.Response) {
    res.sendStatus(404);
  }
  app.use(simple404Middleware);

  /**
   * Cleanup middleware timing tracking
   */
  function timeTrackingMiddleware(req, res, next) {
    if (req.middlewareTimingTracker) {
      req.middlewareTimingTracker.clear();
    }
    next();
  }
  app.use(timeTrackingMiddleware);

  /**
   * Error handler.
   */
  app.use(errorHandler);
};

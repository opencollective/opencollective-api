import { ApolloServer } from 'apollo-server-express';
import config from 'config';
import GraphHTTP from 'express-graphql';
import expressLimiter from 'express-limiter';
import serverStatus from 'express-server-status';
import { get } from 'lodash';
import multer from 'multer';
import redis from 'redis';

import * as connectedAccounts from './controllers/connectedAccounts';
import helloworks from './controllers/helloworks';
import uploadImage from './controllers/images';
import * as email from './controllers/services/email';
import * as users from './controllers/users';
import { stripeWebhook, transferwiseWebhook } from './controllers/webhooks';
import graphqlSchemaV1 from './graphql/v1/schema';
import graphqlSchemaV2 from './graphql/v2/schema';
import logger from './lib/logger';
import * as authentication from './middleware/authentication';
import errorHandler from './middleware/error_handler';
import * as params from './middleware/params';
import required from './middleware/required_param';
import sanitizer from './middleware/sanitizer';
import * as paypal from './paymentProviders/paypal/payment';
import { ErrorTrackingExtension, Sentry, sentryErrorReport } from './sentry';

const upload = multer();

export default app => {
  /**
   * Sentry requestHandler
   */
  app.use(Sentry.Handlers.requestHandler());

  /**
   * Status.
   */
  app.use('/status', serverStatus(app));

  /**
   * Extract GraphQL API Key
   */
  app.use('/graphql/:version/:apiKey?', (req, res, next) => {
    req.apiKey = req.params.apiKey;
    next();
  });

  app.use('*', authentication.checkClientApp);

  app.use('*', authentication.authorizeClientApp);

  // Setup rate limiter
  if (get(config, 'redis.serverUrl')) {
    const client = redis.createClient(get(config, 'redis.serverUrl'));
    const rateLimiter = expressLimiter(
      app,
      client,
    )({
      lookup: function (req, res, opts, next) {
        if (req.clientApp) {
          opts.lookup = 'clientApp.id';
          // 100 requests / minute for registered API Key
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
        if (req.clientApp) {
          message = 'Rate limit exceeded. Contact-us to get higher limits.';
        } else {
          message = 'Rate limit exceeded. Create an API Key to get higher limits.';
        }
        res.status(429).send({ error: { message } });
      },
    });
    app.use('/graphql', rateLimiter);
  }

  /**
   * User reset password or new token flow (no jwt verification)
   */
  app.post('/users/signin', required('user'), users.signin);
  app.post('/users/update-token', authentication.mustBeLoggedIn, users.updateToken);

  /**
   * Moving forward, all requests will try to authenticate the user if there is a JWT token provided
   * (an error will be returned if the JWT token is invalid, if not present it will simply continue)
   */
  app.use('*', authentication.authenticateUser); // populate req.remoteUser if JWT token provided in the request

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
   * GraphQL v1
   */
  const graphqlServerV1 = GraphHTTP(req => ({
    customFormatErrorFn: error => {
      logger.error(`GraphQL v1 error: ${error.message}`);
      logger.debug(error);
      // report error with sentry
      sentryErrorReport(req, error, 'V1');

      return error;
    },
    schema: graphqlSchemaV1,
    pretty: isDevelopment,
    graphiql: isDevelopment,
  }));

  app.use('/graphql/v1', graphqlServerV1);

  /**
   * GraphQL v2
   */
  const graphqlServerV2 = new ApolloServer({
    // Add error tracking extension
    extensions: [() => new ErrorTrackingExtension()],
    schema: graphqlSchemaV2,
    introspection: true,
    playground: isDevelopment,
    // Align with behavior from express-graphql
    context: ({ req }) => {
      return {
        req,
        trackErrors(errors) {
          errors.forEach(error => {
            logger.error(`GraphQL v2 error: ${error.message}`);
            logger.debug(error);
            sentryErrorReport(req, error, 'V2');
          });
        },
      };
    },
  });

  graphqlServerV2.applyMiddleware({ app, path: '/graphql/v2' });

  /**
   * GraphQL default (v1)
   */
  app.use('/graphql', graphqlServerV1);

  /**
   * Webhooks that should bypass api key check
   */
  app.post('/webhooks/stripe', stripeWebhook); // when it gets a new subscription invoice
  app.post('/webhooks/transferwise', transferwiseWebhook); // when it gets a new subscription invoice
  app.post('/webhooks/mailgun', email.webhook); // when receiving an email
  app.get('/connected-accounts/:service/callback', authentication.authenticateServiceCallback); // oauth callback
  app.delete('/connected-accounts/:service/disconnect/:collectiveId', authentication.authenticateServiceDisconnect);

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
  app.get('/connected-accounts/:service(github)', authentication.authenticateService); // backward compatibility
  app.get(
    '/connected-accounts/:service(github|twitter|meetup|stripe|paypal)/oauthUrl',
    authentication.authenticateService,
  );
  app.get('/connected-accounts/:service/verify', authentication.parseJwtNoExpiryCheck, connectedAccounts.verify);

  /* PayPal Payment Method Helpers */
  app.post('/services/paypal/create-payment', paypal.createPayment);

  /**
   * External services
   */
  app.get('/services/email/approve', email.approve);
  app.get('/services/email/unsubscribe/:email/:slug/:type/:token', email.unsubscribe);

  /**
   * Github API - fetch all repositories using the user's access_token
   */
  app.get('/github-repositories', connectedAccounts.fetchAllRepositories); // used in Frontend by createCollective "GitHub flow"
  app.get('/github/repo', connectedAccounts.getRepo); // used in Frontend claimCollective
  app.get('/github/orgMemberships', connectedAccounts.getOrgMemberships); // used in Frontend claimCollective

  /**
   * Hello Works API - Helloworks hits this endpoint when a document has been completed.
   */
  app.post('/helloworks/callback', helloworks.callback);

  /**
   * Override default 404 handler to make sure to obfuscate api_key visible in URL
   */
  app.use((req, res) => res.sendStatus(404));

  /**
   * Sentry errorHandler
   */
  app.use(Sentry.Handlers.errorHandler());

  /**
   * Error handler.
   */
  app.use(errorHandler);
};

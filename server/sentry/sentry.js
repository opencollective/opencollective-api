import * as Sentry from '@sentry/node';
import { sentry } from 'graphql-middleware-sentry'
import { RewriteFrames, Debug } from '@sentry/integrations';

/**
 * Setup Sentry
 */

Sentry.init({ 
dsn: process.env.SENTRY_DSN,
environment: process.env.NODE_ENV,
attachStacktrace: true,
integrations: [
  // used for rewriting SourceMaps from js to ts
  new RewriteFrames({
    root: process.cwd(),
  }),
  // Output sended data by Sentry to console.log()
  // new Debug({ stringify: true }),
],
});

  const sentryMiddleware = sentry({
    sentryInstance: Sentry,
    withScope: (scope, error, context) => {
      scope.setUser({
        id: context.authorization.userId,
      });
      scope.setExtra('body', context.request.body)
      scope.setExtra('origin', context.request.headers.origin)
      scope.setExtra('params', context.request.params)
      scope.setExtra('headers', context.request.headers)
    },
    forwardErrors: true,
    reportError: (res) => true
  })


  export { Sentry, sentryMiddleware};


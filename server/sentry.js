import { RewriteFrames } from '@sentry/integrations';
import * as Sentry from '@sentry/node';
import { GraphQLExtension } from 'graphql-extensions';

/**
 * Setup Sentry
 */

// custom error tracking extension since the request object
// can only be accessed in the context and information from the
// request object would help make the error richer
class ErrorTrackingExtension extends GraphQLExtension {
  willSendResponse(o) {
    const { context, graphqlResponse } = o;
    context.trackErrors(graphqlResponse.errors);
    return o;
  }
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  attachStacktrace: true,
  debug: true,
  integrations: [
    // used for rewriting SourceMaps
    new RewriteFrames({
      root: process.cwd(),
    }),
  ],
});

const sentryErrorReport = (req, error, version) => {
  Sentry.withScope(scope => {
    scope.setTag('error-type', `GraphQl ${version}`);
    scope.setTag('code', req.res.statusCode);
    scope.setExtras({ params: req.params });
    scope.setExtras({ ip: req.ip });
    scope.setExtras({ headers: req.headers });
    scope.setExtras({ body: req.body });
    if (version === 'V2') {
      // get extra details for v2 (GraphQLFormattedError)s
      const { code, exception } = error.extensions;
      scope.setTag('error-code', code);
      scope.setExtras({ exception });
      scope.setExtras({ message: error.message });
      scope.setExtras({ details: { locations: { ...error.locations[0] }, path: error.path } });
    }
    Sentry.captureException(error);
  });
};

export { Sentry, sentryErrorReport, ErrorTrackingExtension };

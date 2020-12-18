import * as Sentry from '@sentry/node';
import * as Tracing from '@sentry/tracing';
import config from 'config';
import * as express from 'express';

export const plugSentryToApp = (app: express.Express): void => {
  if (!config.sentry?.dsn) {
    return;
  }

  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.env,
    attachStacktrace: true,
    enabled: config.env !== 'test',
    integrations: [
      // enable HTTP calls tracing
      new Sentry.Integrations.Http({ tracing: true }),
      // enable Express.js middleware tracing
      new Tracing.Integrations.Express({ app }),
    ],
  });

  // ---- Add request handlers ----
  // RequestHandler creates a separate execution context using domains, so that every
  // transaction/span/breadcrumb is attached to its own Hub instance
  app.use(Sentry.Handlers.requestHandler({ ip: true }));

  // TracingHandler creates a trace for every incoming request
  app.use(Sentry.Handlers.tracingHandler());
};

export const SentryGraphQLPlugin = {
  requestDidStart(_): object {
    return {
      didEncounterErrors(ctx): void {
        // If we couldn't parse the operation, don't do anything here
        if (!ctx.operation) {
          return;
        }

        for (const err of ctx.errors) {
          // Only report internal server errors, all errors extending ApolloError should be user-facing
          if (err.extensions?.code) {
            continue;
          }

          // Add scoped report details and send to Sentry
          Sentry.withScope(scope => {
            // Annotate whether failing operation was query/mutation/subscription
            scope.setTag('kind', ctx.operation.operation);

            // Log query and variables as extras
            scope.setExtra('query', ctx.context.query);
            scope.setExtra('variables', ctx.request.variables);

            // Add logged in user (if any)
            if (ctx.context.remoteUser) {
              scope.setUser({
                id: ctx.context.remoteUser.id,
                CollectiveId: ctx.context.remoteUser.CollectiveId,
              });
            }

            if (err.path) {
              // We can also add the path as breadcrumb
              scope.addBreadcrumb({
                category: 'query-path',
                message: err.path.join(' > '),
                level: Sentry.Severity.Debug,
              });
            }

            Sentry.captureException(err);
          });
        }
      },
    };
  },
};

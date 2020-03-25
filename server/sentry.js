import * as Sentry from '@sentry/node';
import { RewriteFrames, Debug } from '@sentry/integrations';

/**
 * Setup Sentry
 */

Sentry.init({ 
dsn: process.env.SENTRY_DSN,
environment: process.env.NODE_ENV,
attachStacktrace: true,
debug:true,
integrations: [
  // used for rewriting SourceMaps from js to ts
  new RewriteFrames({
    root: process.cwd(),
  }),
  // Output sended data by Sentry to console.log()
  // new Debug({ stringify: true }),
],
});

  export { Sentry };


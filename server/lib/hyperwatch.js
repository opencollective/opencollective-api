import hyperwatch from '@hyperwatch/hyperwatch';
import config from 'config';
import expressBasicAuth from 'express-basic-auth';
import expressWs from 'express-ws';
import { get, pick } from 'lodash-es';

import { timing } from './statsd.js';
import { md5, parseToBoolean } from './utils.js';

const computeMask = req => {
  const maskHeaders = pick(req.headers, [
    'accept',
    'accept-language',
    'cache-control',
    'dnt',
    'pragma',
    'x-requested-with',
  ]);

  const maskString = Object.keys(maskHeaders)
    .map(key => [key, maskHeaders[key]].join(':'))
    .join(';');

  return md5(maskString);
};

const load = async app => {
  if (!config.hyperwatch || parseToBoolean(config.hyperwatch.enabled) !== true) {
    return;
  }

  const { input, lib, modules, pipeline } = hyperwatch;

  // Init
  hyperwatch.init({
    modules: {
      // Expose the status page
      status: { active: true },
      // Expose logs (HTTP and Websocket)
      logs: { active: true },
    },
  });

  // Mount Hyperwatch API and Websocket

  if (config.hyperwatch.secret) {
    // We need to setup express-ws here to make Hyperwatch's websocket works
    expressWs(app);
    const hyperwatchBasicAuth = expressBasicAuth({
      users: { [config.hyperwatch.username]: config.hyperwatch.secret },
      challenge: true,
      realm: config.hyperwatch.realm,
    });
    app.use(config.hyperwatch.path, hyperwatchBasicAuth, hyperwatch.app.api);
    app.use(config.hyperwatch.path, hyperwatchBasicAuth, hyperwatch.app.websocket);
  }

  // Configure input

  const expressInput = input.express.create();

  app.use((req, res, next) => {
    req.startAt = req.startAt || new Date();

    req.mask = computeMask(req);

    const finish = async () => {
      if (req.finishedAt) {
        return;
      }

      req.finishedAt = new Date();
      req.endAt = req.endAt || new Date();
      try {
        const executionTime = req.endAt - req.startAt;
        let log = hyperwatch.util.createLog(req, res).set('executionTime', executionTime);

        log = log.deleteIn(['request', 'headers', 'authorization']);
        log = log.deleteIn(['request', 'headers', 'cookie']);

        if (req.body && req.body.query) {
          log = log.set('graphql', req.body);
          if (res.servedFromGraphqlCache) {
            log = log.setIn(['graphql', 'servedFromCache'], true);
          }
        }

        if (req.personalToken) {
          log = log.setIn(['opencollective', 'personalToken', 'id'], req.personalToken.id);
        }

        if (req.remoteUser) {
          log = log.setIn(['opencollective', 'user', 'id'], req.remoteUser.id);
          log = log.setIn(['opencollective', 'collective', 'id'], req.remoteUser.CollectiveId);
          const collective = await req.loaders.Collective.byId.load(req.remoteUser.CollectiveId);
          if (collective) {
            log = log.setIn(['opencollective', 'collective', 'slug'], collective.slug);
          }
        }

        expressInput.success(log);
      } catch (err) {
        expressInput.reject(err);
      }
    };

    // 30s timeout
    const finishTimeout = setTimeout(() => {
      finish();
    }, 30 * 1000);

    res.on('finish', () => {
      finish();
      clearTimeout(finishTimeout);
    });

    next();
  });

  pipeline.registerInput(expressInput);

  // Configure Pipeline

  pipeline.filter(log => log.has('graphql')).registerNode('graphql');

  pipeline.filter(log => log.get('executionTime') >= config.log.slowRequestThreshold).registerNode('slow');

  // Configure logs

  const formatRequest = log => {
    if (!log.has('graphql')) {
      return lib.formatter.request(log);
    }

    const pickList = [
      'id',
      'slug',
      'collectiveSlug',
      'CollectiveSlug',
      'CollectiveId',
      'legacyExpenseId',
      'tierId',
      'term',
    ];
    const operationName = log.getIn(['graphql', 'operationName'], 'unknown');
    const variables = log.hasIn(['graphql', 'variables']) ? log.getIn(['graphql', 'variables']) : {};
    return `${operationName} ${JSON.stringify(pick(variables, pickList))}`;
  };

  lib.logger.defaultFormatter.replaceFormat('request', formatRequest);

  // GraphQL Metrics
  pipeline.getNode('graphql').map(log => {
    const application = log.getIn(['request', 'headers', 'oc-application']) || 'unknown';
    const operationName = log.getIn(['graphql', 'operationName']) || 'unknown';
    timing(`graphql.${application}.${operationName}.responseTime`, log.get('executionTime'));
  });

  // Access Logs

  const consoleLogOutput = config.env === 'development' ? 'console' : 'text';

  if (get(config, 'log.accessLogs')) {
    pipeline.map(log => console.log(lib.logger.defaultFormatter.format(log, consoleLogOutput)));
  }
  // Or Slow logs
  else if (get(config, 'log.slowRequest')) {
    pipeline.getNode('slow').map(log => console.log(lib.logger.defaultFormatter.format(log, consoleLogOutput)));
  }

  // Start

  modules.start();

  pipeline.start();
};

export default load;

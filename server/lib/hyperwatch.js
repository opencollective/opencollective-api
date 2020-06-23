import hyperwatch from '@hyperwatch/hyperwatch';
import config from 'config';
import expressBasicAuth from 'express-basic-auth';
import expressWs from 'express-ws';
import { get, pick } from 'lodash';

import { parseToBoolean } from './utils';

const load = async app => {
  if (!config.hyperwatch || parseToBoolean(config.hyperwatch.enabled) !== true) {
    return;
  }

  const { input, lib, modules, pipeline } = hyperwatch;

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
    req.startAt = new Date();

    res.on('finish', async () => {
      const { success, reject } = expressInput;
      req.endAt = new Date();
      try {
        const executionTime = req.endAt - req.startAt;
        let log = hyperwatch.util.createLog(req, res).set('executionTime', executionTime);

        log = log.deleteIn(['request', 'headers', 'authorization']);
        log = log.deleteIn(['request', 'headers', 'cookie']);

        if (req.body && req.body.query && req.body.variables) {
          log = log.set('graphql', req.body);
        }

        if (req.clientApp) {
          log = log.setIn(['opencollective', 'application', 'id'], req.clientApp.id);
        }

        if (req.remoteUser) {
          log = log.setIn(['opencollective', 'user', 'id'], req.remoteUser.id);
          log = log.setIn(['opencollective', 'collective', 'id'], req.remoteUser.CollectiveId);
          const collective = await req.loaders.Collective.byId.load(req.remoteUser.CollectiveId);
          if (collective) {
            log = log.setIn(['opencollective', 'collective', 'slug'], collective.slug);
          }
        }

        success(log);
      } catch (err) {
        reject(err);
      }
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

  modules.load();

  pipeline.start();
};

export default load;

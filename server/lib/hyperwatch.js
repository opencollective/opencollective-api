import hyperwatch from '@hyperwatch/hyperwatch';

const { input, modules, pipeline } = hyperwatch;

const expressInput = input.express.create();

export const middleware = (req, res, next) => {
  req.startAt = new Date();
  res.on('finish', () => {
    const { success, reject } = expressInput;
    req.endAt = new Date();
    try {
      const executionTime = req.endAt - req.startAt;
      let log = hyperwatch.util.createLog(req, res).set('executionTime', executionTime);
      if (req.body && req.body.query && req.body.variables) {
        log = log.set('graphql', req.body);
      }
      if (req.clientApp) {
        log = log.setIn(['opencollective', 'application', 'id'], req.clientApp.id);
      }
      if (req.remoteUser) {
        log = log.setIn(['opencollective', 'user', 'id'], req.remoteUser.id);
        log = log.setIn(['opencollective', 'user', 'email'], req.remoteUser.email);
        log = log.setIn(['opencollective', 'collective', 'id'], req.remoteUser.CollectiveId);
      }
      if (success) {
        success(log);
      }
    } catch (err) {
      if (reject) {
        reject(err);
      }
    }
  });
  next();
};

pipeline.registerInput(expressInput);

modules.load();

pipeline.start();

export default hyperwatch;

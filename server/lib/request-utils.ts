import { pickBy, truncate } from 'lodash';

export const getStringIdentifiersFromRequest = (req: Express.Request) => {
  const user = req.remoteUser ? `user:${req.remoteUser.id}` : '';
  const userToken = req.userToken ? `userToken:${req.userToken.id}` : '';
  const personalToken = req.personalToken ? `token:${req.personalToken.id}` : '';
  const apiKey = req.apiKey ? `apiKey:${req.apiKey}` : '';
  const ip = req.ip ? `ip:${req.ip}` : '';
  const graphql = !req.isGraphQL
    ? ''
    : `GraphQL:${truncate(typeof req['body']?.operationName === 'string' ? req['body'].operationName : 'Unknown', {
        length: 50,
      })}`;

  return pickBy({ user, userToken, personalToken, apiKey, ip, graphql }, Boolean);
};

/**
 * Returns a route param as a string.
 *
 * Express 5 types `req.params` values as `string | string[]` because wildcard params (e.g.
 * `/files/*path`) capture a list of path segments. All our routes use named params, which are
 * always plain strings, but array values are joined back into a path just in case.
 */
export const getRouteParam = (req: Express.Request, name: string): string => {
  const value = req.params?.[name];
  return Array.isArray(value) ? value.join('/') : value;
};

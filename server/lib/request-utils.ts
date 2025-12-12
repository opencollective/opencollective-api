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

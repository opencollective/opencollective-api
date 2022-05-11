import OAuthServer from 'express-oauth-server';

import model from './model';

const oauth = new OAuthServer({
  model: model,
});

export const authorizeAuthenticateHandler = {
  handle: function (req) {
    if (req.remoteUser) {
      console.log('authorizeAuthenticateHandler with user');
    } else {
      console.log('authorizeAuthenticateHandler no user');
    }

    return req.remoteUser;
  },
};

export default oauth;

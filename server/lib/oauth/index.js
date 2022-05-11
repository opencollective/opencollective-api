import OAuthServer from 'express-oauth-server';

import model from './model';

const oauth = new OAuthServer({
  model: model,
});

export default oauth;

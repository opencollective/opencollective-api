import cloudflareIps from 'cloudflare-ip/ips.json';
import config from 'config';
import connectRedis from 'connect-redis';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import errorHandler from 'errorhandler';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { get, has } from 'lodash';
import passport from 'passport';
import { Strategy as GitHubStrategy } from 'passport-github';
import { Strategy as TwitterStrategy } from 'passport-twitter';
import redis from 'redis';

import hyperwatch from './hyperwatch';
import logger from './logger';

export default async function (app) {
  app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal'].concat(cloudflareIps));

  app.use(
    helmet({
      // It's currently breaking GraphQL playgrounds, to consider when activating this
      contentSecurityPolicy: false,
    }),
  );

  // Body parser.
  app.use(
    express.json({
      limit: '50mb',
      // If the request is routed to our /webhooks/transferwise endpoint, we add
      // the request body buffer to a new property called `rawBody` so we can
      // calculate the checksum to verify if the request is authentic.
      verify(req, res, buf) {
        if (req.originalUrl.startsWith('/webhooks')) {
          req.rawBody = buf.toString();
        }
      },
    }),
  );
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Hyperwatch
  await hyperwatch(app);

  // Error handling.
  if (config.env !== 'production' && config.env !== 'staging') {
    app.use(errorHandler());
  }

  // Cors.
  app.use(cors());

  const verify = (accessToken, tokenSecret, profile, done) => done(null, accessToken, { tokenSecret, profile });

  if (has(config, 'github.clientID') && has(config, 'github.clientSecret')) {
    passport.use(new GitHubStrategy(get(config, 'github'), verify));
  } else {
    logger.info('Configuration missing for passport GitHubStrategy, skipping.');
  }
  if (has(config, 'twitter.consumerKey') && has(config, 'twitter.consumerSecret')) {
    passport.use(new TwitterStrategy(get(config, 'twitter'), verify));
  } else {
    logger.info('Configuration missing for passport TwitterStrategy, skipping.');
  }

  app.use(cookieParser());

  // Setup session (required by passport)

  let store;
  if (get(config, 'redis.serverUrl')) {
    const RedisStore = connectRedis(session);
    const redisOptions = {};
    if (get(config, 'redis.serverUrl').includes('rediss://')) {
      redisOptions.tls = { rejectUnauthorized: false };
    }
    store = new RedisStore({
      client: redis.createClient(get(config, 'redis.serverUrl'), redisOptions),
    });
  }

  app.use(
    session({
      store,
      secret: config.keys.opencollective.sessionSecret,
      resave: false,
      saveUninitialized: false,
    }),
  );

  app.use(passport.initialize());
}

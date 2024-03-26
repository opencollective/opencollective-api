import config from 'config';
import * as hcaptcha from 'hcaptcha';

import CAPTCHA_PROVIDERS from '../constants/captcha-providers';

import logger from './logger';
import recaptcha from './recaptcha';
import turnstile from './turnstile';
import { parseToBoolean } from './utils';

export async function checkCaptcha(captcha: { token: string; provider: CAPTCHA_PROVIDERS }, reqIp: string) {
  const isCaptchaEnabled = parseToBoolean(config.captcha?.enabled);

  if (!isCaptchaEnabled) {
    return;
  }

  const { provider, token } = captcha || {};

  if (!token) {
    throw new Error('You need to provide a valid captcha token');
  }
  let response;
  if (provider === CAPTCHA_PROVIDERS.HCAPTCHA && config.hcaptcha?.secret) {
    response = await hcaptcha.verify(config.hcaptcha.secret, token, reqIp, config.hcaptcha.sitekey);
  } else if (provider === CAPTCHA_PROVIDERS.RECAPTCHA && config.recaptcha && parseToBoolean(config.recaptcha.enable)) {
    response = await recaptcha.verify(token, reqIp);
  } else if (provider === CAPTCHA_PROVIDERS.TURNSTILE && config.turnstile?.secretKey) {
    response = await turnstile.verify(token, reqIp);
  } else {
    throw new Error('Could not find requested Captcha provider');
  }

  if (response.success !== true) {
    logger.warn('Captcha verification failed:', response);
    throw new Error('Captcha verification failed');
  }

  return response;
}

import { URLSearchParams } from 'url';

import config from 'config';
import fetch from 'node-fetch';

import { reportErrorToSentry } from './sentry';

const turnstileVerifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const turnstileSecretKey = config.turnstile?.secretKey;

async function turnstileVerify(turnstileToken, remoteIp): Promise<{ success: boolean }> {
  const method = 'POST';

  const body = new URLSearchParams();
  body.set('secret', turnstileSecretKey);
  body.set('response', turnstileToken);
  body.set('remoteip', remoteIp);

  try {
    const response = await fetch(turnstileVerifyUrl, { method, body });
    return response.json();
  } catch (err) {
    reportErrorToSentry(err);
    return { success: false };
  }
}

export default {
  verify: turnstileVerify,
};

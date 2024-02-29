import { URLSearchParams } from 'url';

import config from 'config';
import debug from 'debug';
import fetch from 'node-fetch';

const turnstileVerifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const turnstileSecretKey = config.turnstile?.secretKey;
const turnstileDebug = debug('turnstile');

async function turnstileVerify(turnstileToken, remoteIp) {
  const method = 'POST';

  const body = new URLSearchParams();
  body.set('secret', turnstileSecretKey);
  body.set('response', turnstileToken);
  body.set('remoteip', remoteIp);

  try {
    const response = await fetch(turnstileVerifyUrl, { method, body });
    const result = await response.json();
    turnstileDebug(result);
    return result;
  } catch (err) {
    turnstileDebug(err);
  }
}

export default {
  verify: turnstileVerify,
};

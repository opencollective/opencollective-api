import { URLSearchParams } from 'url';

import config from 'config';
import debug from 'debug';

const recaptchaVerifyUrl = 'https://www.google.com/recaptcha/api/siteverify';
const recaptchaSecretKey = config.recaptcha.secretKey;
const recaptchaDebug = debug('recaptcha');

type RecaptchaVerifyResponse = {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  'error-codes'?: string[];
};

async function recaptchaVerify(recaptchaToken: string, remoteIp: string): Promise<RecaptchaVerifyResponse | undefined> {
  const method = 'POST';

  const body = new URLSearchParams();
  body.set('secret', recaptchaSecretKey);
  body.set('response', recaptchaToken);
  body.set('remoteip', remoteIp);

  try {
    const response = await fetch(recaptchaVerifyUrl, { method, body });
    const result = (await response.json()) as RecaptchaVerifyResponse;
    recaptchaDebug(result);
    return result;
  } catch (err) {
    recaptchaDebug(err);
  }
}

export default {
  verify: recaptchaVerify,
};

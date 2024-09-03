import Paypal from '@opencollective/paypal-adaptive';
import config from 'config';
import debug from 'debug';
import { get } from 'lodash';

const debugPaypal = debug('paypal');

const paypalAdaptiveClient = new Paypal({
  userId: config.paypal.classic.userId,
  password: config.paypal.classic.password,
  signature: config.paypal.classic.signature,
  appId: config.paypal.classic.appId,
  sandbox: config.env !== 'production',
});

const callPaypal = (method, payload) => {
  // Needs to be included in every call to PayPal
  const requestEnvelope = {
    errorLanguage: 'en_US',
    detailLevel: 'ReturnAll',
  };

  // Note you can't use Promise.promisify because error details are in the response,
  // not always in the err
  debugPaypal(`Paypal ${method} payload: ${JSON.stringify(payload)}`); // leave this in permanently
  return new Promise((resolve, reject) => {
    method(Object.assign({}, payload, { requestEnvelope }), (err, res) => {
      debugPaypal(`Paypal ${method} response: ${JSON.stringify(res)}`); // leave this in permanently
      if (get(res, 'responseEnvelope.ack') === 'Failure') {
        if (res.error[0].errorId === '579024') {
          return reject(
            new Error(
              `Your PayPal pre-approval has expired, please reconnect your account by clicking on 'Refill Balance'.`,
            ),
          );
        } else {
          return reject(new Error(`PayPal error: ${res.error[0].message} (error id: ${res.error[0].errorId})`));
        }
      }
      if (err) {
        debugPaypal(`Paypal ${method} error: ${JSON.stringify(err)}`); // leave this in permanently
        if (err.code === 'ENOTFOUND' && err.syscall === 'getaddrinfo') {
          return reject(new Error(`Unable to reach ${err.hostname}`));
        }
        const errormsg = get(res, 'error[0].message') || JSON.stringify(err); // error details are included in the response, sometimes sigh.
        return reject(new Error(errormsg));
      }
      resolve(res);
    });
  });
};

const paypalAdaptive = {
  pay: payload => callPaypal(paypalAdaptiveClient.pay, payload),
  paymentDetails: payload => callPaypal(paypalAdaptiveClient.paymentDetails, payload),
  executePayment: (payKey: string) =>
    callPaypal(paypalAdaptiveClient.executePayment, { payKey }) as Promise<{
      httpStatusCode: number;
      paymentExecStatus: string;
      responseEnvelope: { ack: string; build: string; timestamp: string; correlationId: string };
      payErrorList?: Array<{ error: { message: string } }>;
    }>,
  preapproval: payload => callPaypal(paypalAdaptiveClient.preapproval, payload),
  preapprovalDetails: preapprovalKey => callPaypal(paypalAdaptiveClient.preapprovalDetails, { preapprovalKey }),
};

export default paypalAdaptive;

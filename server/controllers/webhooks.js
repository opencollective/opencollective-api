import paymentProviders from '../paymentProviders';

export default function stripeWebhook(req, res, next) {

  const { body } = req;
  const isProduction = process.env.NODE_ENV === 'production';

  // Stripe sends test events to production as well
  // don't do anything if the event is not livemode
  if (isProduction && !body.livemode) {
    return res.sendStatus(200);
  }

  return paymentProviders.stripe.webhook(body)
    .then(() => res.sendStatus(200))
    .catch(next)

}

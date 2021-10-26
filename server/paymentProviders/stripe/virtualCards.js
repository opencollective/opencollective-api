import { omit } from 'lodash';
import Stripe from 'stripe';

import models from '../../models';

const stripe = Stripe('sk_test_XXX');

export const assignCardToCollective = async (cardNumberLabel, expireDate, cvv, collectiveId, host, userId) => {
  const cardNumber = cardNumberLabel.replace(/\s\s/gm, '');

  const list = await stripe.issuing.cards.list({ last4: cardNumber.slice(-4) });
  const cards = list.data;

  let matchingCard;

  for (const card of cards) {
    const stripeCard = await stripe.issuing.cards.retrieve(card.id, { expand: ['number', 'cvc'] });

    if (
      stripeCard.number === cardNumber &&
      stripeCard.cvc === cvv &&
      stripeCard['exp_month'] === parseInt(expireDate.slice(0, 2)) &&
      stripeCard['exp_year'] === parseInt(expireDate.slice(-4))
    ) {
      matchingCard = stripeCard;
      break;
    }
  }

  if (!matchingCard) {
    throw new Error('Could not find a Stripe Card matching the submitted card');
  }

  const cardData = {
    id: matchingCard.id,
    name: matchingCard.last4,
    last4: matchingCard.last4,
    privateData: { cardNumber: cardNumberLabel, expireDate, cvv },
    data: omit(matchingCard, ['number', 'cvc', 'exp_year', 'exp_month']),
    CollectiveId: collectiveId,
    HostCollectiveId: host.id,
    UserId: userId,
    provider: 'stripe',
    spendingLimitAmount: matchingCard['spending_controls']['spending_limits'][0]['amount'],
    spendingLimitInterval: matchingCard['spending_controls']['spending_limits'][0]['interval'].toUpperCase(),
  };

  return await models.VirtualCard.create(cardData);
};

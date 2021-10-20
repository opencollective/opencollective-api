import Stripe from 'stripe';

const stripe = Stripe('sk_test_XXX');

export const verifyCardExists = async (cardNumber, expireDate, cvc) => {
  const list = await stripe.issuing.cards.list({ last4: cardNumber.slice(-4) });
  const cards = list.data;

  let cardExists = false;

  for (const card of cards) {
    const cardWithNumber = await stripe.issuing.cards.retrieve(card.id, { expand: ['number', 'cvc'] });

    if (
      cardWithNumber.number === cardNumber &&
      cardWithNumber.cvc === cvc &&
      cardWithNumber['exp_month'] === parseInt(expireDate.slice(0, 2)) &&
      cardWithNumber['exp_year'] === parseInt(expireDate.slice(-4))
    ) {
      cardExists = true;
      break;
    }
  }

  return cardExists;
};

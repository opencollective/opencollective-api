import models from '../../models';


/*  -- Giftcard Generation -- */

const VERIFICATION_MODULO = 45797;

/** Generate random string to be used in a Giftcard token */
export function randomString(length, chars) {
  let result = '';
  for (let i = length; i > 0; --i) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/** Generate the verification number of a token */
export function getVerificationNumber(str) {
  const data = Array.prototype.map
    .call(str, c => c.charCodeAt(0))
    .reduce((a, b) => a * b) % VERIFICATION_MODULO;
  return data.toString().substr(-1);
}

/** Generate a new token for a gift card */
export function newToken(prefix) {
  // generate three letters (ignoring confusing ones)
  const letters = randomString(3, 'ACEFHJKLMNPRSTUVWXY');
  // generate three digit number
  const numbers = randomString(3, '123456789');
  // generate verification number
  const code = `${prefix}${letters}${numbers}`;
  const verification = getVerificationNumber(code);

  if (letters.length !== 3 || numbers.toString().length != 3 || verification.toString().length !== 1) {
    throw new Error('Incorrect length found', letters, numbers, verification);
  }
  return `${code}${verification}`;
}

/** Create the data for batches of giftcards */
export function createGiftcardData(batches, opts) {
  const {
    name,
    CollectiveId,
    CreatedByUserId,
    monthlyLimitPerMember,
    currency,
  } = opts;

  // Prefix for the token strings
  const prefix = name[0].toUpperCase().repeat(2);

  const cardList = [];

  batches.forEach(batch => {
    for (let i = 0; i < batch.count; i++) {
      const token = newToken(prefix);
      cardList.push({
        name,
        token,
        currency,
        monthlyLimitPerMember, // overloading to serve as prepaid amount
        expiryDate: batch.expiryDate,
        CreatedByUserId,
        CollectiveId,
        service: 'opencollective',
        type: 'prepaid',
      });
    }
  });
  return cardList;
}

/** Generate Giftcards in batches
 *
 * @param {Object[]} batches Array of objects containing the number of
 *  cards and expiry date of each batch.
 * @param {Object} opts Configure how the giftcards should be created
 * @param {String} opts.name Name of the giftcard. The first letter of
 *  the name is also used as the prefix of the card.
 * @param {Number} opts.CreatedByUserId user id of the creator or the
 *  admin of the collective funding gift cards.
 * @param {Number} opts.CollectiveId issuer's collective ID.
 * @param {Number} opts.monthlyLimitPerMember Limit for the value of
 *  the card that can be used per month in cents.
 * @param {String} opts.currency Currency of the giftcard.
 */
export async function createGiftcards(batches, opts) {
  const data = createGiftcardData(batches, opts);
  return models.PaymentMethod.bulkCreate(data);
}

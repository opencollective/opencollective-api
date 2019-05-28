import debugLib from 'debug';
import blockstack from 'blockstack';
import models from '../models';
const debug = debugLib('blockstack');

/*
 * encrypts login link
 */
const encryptLink = (publicKey, loginLink) => {
  debug('Encrypting ', loginLink, 'with', publicKey);
  return blockstack.encryptContent(loginLink, { publicKey });
};

const findOne = user => {
  if (user.publicKey) {
    return models.User.findOne({ where: { publicKey: user.publicKey } }).then(u => {
      if (u.email === user.email.toLowerCase()) {
        return u;
      } else {
        return null;
      }
    });
  } else {
    return models.User.findOne({ where: { email: user.email.toLowerCase() } });
  }
};
const blockstackLib = {
  encryptLink,
  findOne,
};

export default blockstackLib;

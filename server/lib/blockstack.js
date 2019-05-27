import debugLib from 'debug';
import blockstack from 'blockstack';
const debug = debugLib('blockstack');

/*
 * encrypts login link
 */
const encryptLink = (publicKey, loginLink) => {
  debug('Encrypting ', loginLink, 'with', publicKey);
  return blockstack.encryptContent(loginLink, { publicKey });
};

const blockstackLib = {
  encryptLink,
};

export default blockstackLib;

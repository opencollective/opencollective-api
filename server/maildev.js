// ignore unused exports default

import MailDev from 'maildev'; // eslint-disable-line node/no-unpublished-import

const maildev = new MailDev({ smtp: 1025, ip: '127.0.0.1' });

export default maildev;

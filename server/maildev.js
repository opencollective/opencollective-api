import MailDev from 'maildev'; // eslint-disable-line n/no-unpublished-import

const maildev = new MailDev({ smtp: 1025, ip: '127.0.0.1' });

// ts-unused-exports:disable-next-line
export default maildev;

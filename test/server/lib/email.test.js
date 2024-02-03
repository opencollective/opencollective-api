import { expect } from 'chai';
import config from 'config';
import nodemailer from 'nodemailer';
import { stub } from 'sinon';

import emailLib from '../../../server/lib/email';
import { md5 } from '../../../server/lib/utils';
import * as utils from '../../utils';

const emailData = utils.data('emailData');

describe('server/lib/email', () => {
  describe('Sending emails', () => {
    let nm;

    // create a fake nodemailer transport
    beforeEach(done => {
      config.mailgun.user = 'xxxxx';
      config.mailgun.password = 'password';

      nm = nodemailer.createTransport({
        name: 'testsend',
        service: 'Mailgun',
        sendMail(data, callback) {
          callback();
        },
        logger: false,
      });
      stub(nodemailer, 'createTransport').callsFake(() => {
        return nm;
      });
      done();
    });

    // stub the transport
    beforeEach(done => {
      stub(nm, 'sendMail').callsFake((object, cb) => {
        cb(null, object);
      });
      done();
    });

    afterEach(done => {
      nm.sendMail.restore();
      done();
    });

    afterEach(() => {
      config.mailgun.user = '';
      config.mailgun.password = '';
      nodemailer.createTransport.restore();
    });

    it('sends the order.confirmed.fr email template', async () => {
      const template = 'order.confirmed';
      const collective = { name: 'En Marche', slug: 'enmarchebe' };
      const data = {
        order: { totalAmount: 5000, currency: 'EUR' },
        transaction: { uuid: '17811b3e-0ac4-4101-81d4-86e9e0aefd7b' },
        config: { host: config.host },
        interval: 'month',
        firstPayment: false,
        user: emailData.user,
        fromCollective: { id: 1, slug: 'xdamman', name: 'Xavier' },
        collective,
      };
      const options = {
        from: `"${collective.name}" <hello@opencollective.com>`,
      };
      await emailLib.send(template, data.user.email, data, options);
      let amountStr = 50;
      amountStr = amountStr.toLocaleString('fr-FR', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      expect(nm.sendMail.lastCall.args[0].from).to.equal(options.from);
      expect(nm.sendMail.lastCall.args[0].to).to.equal('emailbcc+user1-at-opencollective.com@opencollective.com');
      expect(nm.sendMail.lastCall.args[0].subject).to.contain(
        `Merci pour votre contribution de ${amountStr}/mois à En Marche`,
      );
      expect(nm.sendMail.lastCall.args[0].html).to.contain('Merci pour continuer à nous soutenir');
      expect(nm.sendMail.lastCall.args[0].html).to.contain('donate');
      expect(nm.sendMail.lastCall.args[0].headers['X-Mailgun-Tag']).to.equal('internal');

      expect(nm.sendMail.lastCall.args[0].html).to.matchSnapshot();
      expect(nm.sendMail.lastCall.args[0].text).to.matchSnapshot();
    });

    it('sends the order.confirmed.wwcode email template', async () => {
      const paymentData = {
        totalAmount: 5000,
        currency: 'USD',
      };

      const data = {
        order: paymentData,
        transaction: { uuid: '17811b3e-0ac4-4101-81d4-86e9e0aefd7b' },
        config: { host: config.host },
        interval: 'month',
        user: emailData.user,
        collective: {
          name: 'WWCode Austin',
          slug: 'wwcodeaustin',
        },
      };
      await emailLib.send('order.confirmed', data.user.email, data);
      let amountStr = 50;
      amountStr = amountStr.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      expect(nm.sendMail.lastCall.args[0].to).to.equal('emailbcc+user1-at-opencollective.com@opencollective.com');
      expect(nm.sendMail.lastCall.args[0].subject).to.contain(
        `Thank you for your ${amountStr}/month donation to WWCode Austin`,
      );
    });
  });

  describe('Unsubscribe', () => {
    const EMAIL_ADDRESS = 'user@opencollective.com';
    const COLLECTIVE_SLUG = 'collective_slug';
    const EMAIL_TYPE = 'test-notification';

    describe('generateUnsubscribeToken', () => {
      it('generates new tokens as SHA512', () => {
        const { generateUnsubscribeToken } = emailLib;
        const token = generateUnsubscribeToken(EMAIL_ADDRESS, COLLECTIVE_SLUG, EMAIL_TYPE);
        expect(token).to.eq(
          'c8b476c8ac6f5347fc059628947a61fb354125157ca9060de38cd1189b3257710c034e7d4d559787174c678a78de831737c8b6a631ec8a5a0a5edbd68a8a7e67',
        );
      });

      it('generates legacy tokens with MD5', () => {
        const { generateUnsubscribeToken } = emailLib;
        const token = generateUnsubscribeToken(EMAIL_ADDRESS, COLLECTIVE_SLUG, EMAIL_TYPE, md5);
        expect(token).to.eq('0227ed95b740e41d8359667e3e3baa9c');
      });
    });

    describe('isValidUnsubscribeToken', () => {
      it('detects invalid tokens', () => {
        const { isValidUnsubscribeToken } = emailLib;
        expect(isValidUnsubscribeToken('', EMAIL_ADDRESS, COLLECTIVE_SLUG, EMAIL_TYPE)).to.be.false;
        expect(isValidUnsubscribeToken('test', EMAIL_ADDRESS, COLLECTIVE_SLUG, EMAIL_TYPE)).to.be.false;
      });

      it('works with new tokens', () => {
        const { generateUnsubscribeToken, isValidUnsubscribeToken } = emailLib;
        const token = generateUnsubscribeToken(EMAIL_ADDRESS, COLLECTIVE_SLUG, EMAIL_TYPE);
        expect(isValidUnsubscribeToken(token, EMAIL_ADDRESS, COLLECTIVE_SLUG, EMAIL_TYPE)).to.be.true;
      });

      it('works with legacy tokens', () => {
        const { generateUnsubscribeToken, isValidUnsubscribeToken } = emailLib;
        const token = generateUnsubscribeToken(EMAIL_ADDRESS, COLLECTIVE_SLUG, EMAIL_TYPE, md5);
        expect(isValidUnsubscribeToken(token, EMAIL_ADDRESS, COLLECTIVE_SLUG, EMAIL_TYPE)).to.be.true;
      });
    });
  });

  describe('render', () => {
    it('Automatically generates text version', () => {
      const result = emailLib.render('user.new.token', { loginLink: 'https://opencollective/USER_LOGIN_LINK' });
      expect(result.html).to.matchSnapshot();
      expect(result.text).to.matchSnapshot();
    });
  });

  describe('generateFromEmailHeader', () => {
    it('sanitizes invalid characters', () => {
      expect(emailLib.generateFromEmailHeader('Hello World')).to.equal('"Hello World" <no-reply@opencollective.com>');
      expect(emailLib.generateFromEmailHeader('Hello World <NOPE>')).to.equal(
        '"Hello World <NOPE>" <no-reply@opencollective.com>',
      );
      expect(emailLib.generateFromEmailHeader('Hello "World" <NOPE>')).to.equal(
        '"Hello “World“ <NOPE>" <no-reply@opencollective.com>',
      );
      expect(
        emailLib.generateFromEmailHeader(
          `Hello
      
          “World“     <NOPE>`,
        ),
      ).to.equal('"Hello “World“ <NOPE>" <no-reply@opencollective.com>');
    });

    it('can customize the email address', () => {
      expect(emailLib.generateFromEmailHeader('Hello World', 'test@opencollective.com')).to.equal(
        '"Hello World" <test@opencollective.com>',
      );
    });
  });
});

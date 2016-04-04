const app = require('../index');
const emailLib = require('../app/lib/email')(app);
const expect = require('chai').expect;
const utils = require('../test/utils.js')();
const emailData = utils.data('emailData');
const config = require('config');

describe('lib/email', () => {
  
  it('sends the thankyou.fr email template', function(done) {
    this.timeout(2000);
    
    const paymentData = {
      amountFloat: 50.00,
      currency: 'EUR'
     };

    const data = {
      donation: paymentData,
      interval: 'month',
      user: emailData.user,
      group: {
        name: "La Primaire",
        slug: "laprimaire"
      },
      config: config
    };

    const previousSendMail = app.mailgun.sendMail;
    app.mailgun.sendMail = (options) => {
      expect(options.to).to.equal(data.user.email);
      console.log("Called!", options.subject);
      expect(options.subject).to.contain('Merci pour votre donation de €50/mois à La Primaire');
      console.log("html:",options.html);
      done();
      app.mailgun.sendMail = previousSendMail;
      return options;
    }

    emailLib.send('thankyou', data.user.email, data);

  });
});
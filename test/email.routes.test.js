import {expect} from 'chai';
const app = require('../index');
const models = app.set('models');
const Group = models.Group;
const User = models.User;
const request = require('supertest-as-promised');
const utils = require('../test/utils.js')();
const Promise = require('bluebird');
const sinon = require('sinon');
const emailLib = require('../server/lib/email');

const webhookBody = {"Content-Type":"multipart/related; boundary=\"001a11409be415d9d50539df51c8\"","Date":"Fri, 12 Aug 2016 14:49:24 +0200","Dkim-Signature":"v=1; a=rsa-sha256; c=relaxed/relaxed;        d=gmail.com; s=20120113;        h=mime-version:reply-to:from:date:message-id:subject:to;bh=QgeZVgMl/Qpv6eFi4PMMGCZ/p9EmzLbhAeiRsGdko84=;        b=amplu+CA9P/1ifyoU8ukJlzTQv3ualXvymegbZ2mMuHYczRpPNzOuWW2ofkBS3jojI         r4k9Ypk+k93fPKrxEC7ZUdsdrYkFMC2wkkyQ5NZctnW1DJjYcP6UOkAokv88oTqNhYPf         t+7+qule3h/kJDGHyGp1HTFY+eyxZvcjP5A+J6dhSqY6DHIZp3OCSdwI2F/iec6sLky2         b9TdZHdiMk6rEXpXNOyCUHKvFRWsWIJHuybU7lQRs6GW+DLnR9TuhCSinAYfFvjYkyhN         ayawItq+3+p+irjr9jzOmvwbxAJT6eGkStpR/LGVvXZFD9BXztZFwQNLeOHiqDq+7dec         H+qQ==","From":"Xavier Damman <xdamman@gmail.com>","Message-Id":"<CAFPTvg9=-Fm-fO1=b=gG7Hvh2-hqugzfGxFXO8f4sTQuY7ej_A@mail.gmail.com>","Mime-Version":"1.0","Received":["from mail-yw0-f194.google.com (mail-yw0-f194.google.com [209.85.161.194]) by mxa.mailgun.org with ESMTP id 57adcb09.7f957c0c03f0-in01; Fri, 12 Aug 2016 13:11:37 -0000 (UTC)","by mail-yw0-f194.google.com with SMTP id j12so1099707ywb.1        for <backers@testcollective.opencollective.com>; Fri, 12 Aug 2016 06:11:37 -0700 (PDT)","by 10.83.8.193 with HTTP; Fri, 12 Aug 2016 05:49:24 -0700 (PDT)"],"Reply-To":"xdamman@gmail.com","Subject":"test subject to backers","To":"backers@testcollective.opencollective.com","X-Envelope-From":"<xdamman@gmail.com>","X-Gm-Message-State":"AEkooutv6cSldRDCPMCG8MlGPiRdcrMfPLKEf4etQLfkzAmruJtySwR61AZU5CXoP6sHwIvlKMYfaXVauJ/Z+w==","X-Google-Dkim-Signature":"v=1; a=rsa-sha256; c=relaxed/relaxed;        d=1e100.net; s=20130820;        h=x-gm-message-state:mime-version:reply-to:from:date:message-id         :subject:to;        bh=QgeZVgMl/Qpv6eFi4PMMGCZ/p9EmzLbhAeiRsGdko84=;        b=hVeByQFuDy251auRxG6cmfpFAyZREw/kcfYY7xJxxgcebFF17NufynEG+tB0waxkCC         6Ggwesq2/amDZfhCwh0J1ujsHAdR05A6MmaiY01KWKUlazVWcYcnQevqR8g/k6fIoUfS         XhSUBto3grSgRZfNXiNGEBrs3brsU6gVA2v3vjKtUsy5Yd7sjpEL8fBy7NXJEiQEhyBZ         a0meePuB7E3rZ5CHj5eodMNvswOJpU2AvQXjXLiErvEUtoym8R+UJzAh4NJV9UL0ffBE         +Pk8Rr8IIeUcAhNB6DondRkKs2kfnFIcVc1FE4AlAg7r46g1O/GaKLlUB2uJEgoN7r8m         5ZHw==","X-Mailgun-Incoming":"Yes","X-Received":"by 10.129.40.194 with SMTP id o185mr10647137ywo.45.1471006184412; Fri, 12 Aug 2016 05:49:44 -0700 (PDT)","attachment-count":"1","body-html":"<div dir=\"ltr\">hello world<div><br></div><div>Some <b>HTML</b> <a href=\"https://google.com\">here</a></div><div><br></div><div><img src=\"cid:ii_1567ecc9136e251f\" alt=\"Inline image 1\" width=\"520\" height=\"347\"><br></div><div><br></div><div>Image and more!</div></div>\r\n","body-plain":"hello world\r\n\r\nSome *HTML* here <https://google.com>\r\n\r\n[image: Inline image 1]\r\n\r\nImage and more!\r\n","content-id-map":"{\"<ii_1567ecc9136e251f>\": \"attachment-1\"}","from":"Xavier Damman <xdamman@gmail.com>","message-headers":"[[\"X-Mailgun-Incoming\", \"Yes\"], [\"X-Envelope-From\", \"<xdamman@gmail.com>\"], [\"Received\", \"from mail-yw0-f194.google.com (mail-yw0-f194.google.com [209.85.161.194]) by mxa.mailgun.org with ESMTP id 57adcb09.7f957c0c03f0-in01; Fri, 12 Aug 2016 13:11:37 -0000 (UTC)\"], [\"Received\", \"by mail-yw0-f194.google.com with SMTP id j12so1099707ywb.1        for <backers@testcollective.opencollective.com>; Fri, 12 Aug 2016 06:11:37 -0700 (PDT)\"], [\"Dkim-Signature\", \"v=1; a=rsa-sha256; c=relaxed/relaxed;        d=gmail.com; s=20120113;        h=mime-version:reply-to:from:date:message-id:subject:to;        bh=QgeZVgMl/Qpv6eFi4PMMGCZ/p9EmzLbhAeiRsGdko84=;        b=amplu+CA9P/1ifyoU8ukJlzTQv3ualXvymegbZ2mMuHYczRpPNzOuWW2ofkBS3jojI         r4k9Ypk+k93fPKrxEC7ZUdsdrYkFMC2wkkyQ5NZctnW1DJjYcP6UOkAokv88oTqNhYPf         t+7+qule3h/kJDGHyGp1HTFY+eyxZvcjP5A+J6dhSqY6DHIZp3OCSdwI2F/iec6sLky2         b9TdZHdiMk6rEXpXNOyCUHKvFRWsWIJHuybU7lQRs6GW+DLnR9TuhCSinAYfFvjYkyhN         ayawItq+3+p+irjr9jzOmvwbxAJT6eGkStpR/LGVvXZFD9BXztZFwQNLeOHiqDq+7dec         H+qQ==\"], [\"X-Google-Dkim-Signature\", \"v=1; a=rsa-sha256; c=relaxed/relaxed;        d=1e100.net; s=20130820;        h=x-gm-message-state:mime-version:reply-to:from:date:message-id         :subject:to;        bh=QgeZVgMl/Qpv6eFi4PMMGCZ/p9EmzLbhAeiRsGdko84=;        b=hVeByQFuDy251auRxG6cmfpFAyZREw/kcfYY7xJxxgcebFF17NufynEG+tB0waxkCC         6Ggwesq2/amDZfhCwh0J1ujsHAdR05A6MmaiY01KWKUlazVWcYcnQevqR8g/k6fIoUfS         XhSUBto3grSgRZfNXiNGEBrs3brsU6gVA2v3vjKtUsy5Yd7sjpEL8fBy7NXJEiQEhyBZ         a0meePuB7E3rZ5CHj5eodMNvswOJpU2AvQXjXLiErvEUtoym8R+UJzAh4NJV9UL0ffBE         +Pk8Rr8IIeUcAhNB6DondRkKs2kfnFIcVc1FE4AlAg7r46g1O/GaKLlUB2uJEgoN7r8m         5ZHw==\"], [\"X-Gm-Message-State\", \"AEkooutv6cSldRDCPMCG8MlGPiRdcrMfPLKEf4etQLfkzAmruJtySwR61AZU5CXoP6sHwIvlKMYfaXVauJ/Z+w==\"], [\"X-Received\", \"by 10.129.40.194 with SMTP id o185mr10647137ywo.45.1471006184412; Fri, 12 Aug 2016 05:49:44 -0700 (PDT)\"], [\"Mime-Version\", \"1.0\"], [\"Received\", \"by 10.83.8.193 with HTTP; Fri, 12 Aug 2016 05:49:24 -0700 (PDT)\"], [\"Reply-To\", \"xdamman@gmail.com\"], [\"From\", \"Xavier Damman <xdamman@gmail.com>\"], [\"Date\", \"Fri, 12 Aug 2016 14:49:24 +0200\"], [\"Message-Id\", \"<CAFPTvg9=-Fm-fO1=b=gG7Hvh2-hqugzfGxFXO8f4sTQuY7ej_A@mail.gmail.com>\"], [\"Subject\", \"test subject to backers\"], [\"To\", \"backers@testcollective.opencollective.com\"], [\"Content-Type\", \"multipart/related; boundary=\\\"001a11409be415d9d50539df51c8\\\"\"]]","recipient":"backers@testcollective.opencollective.com","sender":"xdamman@gmail.com","signature":"bde8b345ec1e9a2acef18642e280de851b69f861f24dade67d7f4f61a15c1a29","stripped-html":"<div dir=\"ltr\">hello world<div><br></div><div>Some <b>HTML</b> <a href=\"https://google.com\">here</a></div><div><br></div><div><img src=\"cid:ii_1567ecc9136e251f\" alt=\"Inline image 1\" width=\"520\" height=\"347\"><br></div><div><br></div><div>Image and more!</div></div>","stripped-text":"hello world\r\n\r\nSome *HTML* here <https://google.com>\r\n\r\n[image: Inline image 1]\r\n\r\nImage and more!","subject":"test subject to backers","timestamp":"1471007498","token":"6d2375e1e041e46efa1afa9ec6893664d17534298d35f71fab"};

const usersData = [
  {
    name: 'Xavier Damman',
    email: 'xdamman@gmail.com',
    role: 'MEMBER'
  },
  {
    name: 'Aseem Sood',
    email: 'asood123@gmail.com',
    role: 'MEMBER'
  },
  {
    name: 'Pia Mancini',
    email: 'pia@opencollective.com',
    role: 'BACKER'
  },
  {
    name: 'github',
    email: 'github@opencollective.com',
    role: 'BACKER'
  }
]

const groupData = {
  slug: 'testcollective',
  name: 'Test Collective',
  settings: {}
}

let group;

const stub = sinon.stub(emailLib, 'send', (template, recipient, data) => {
  console.log("emailLib.send called with ", arguments);
  return Promise.resolve();
});

describe("controllers.services.email", () => {

  before((done) => utils.cleanAllDb().tap(a => done()));

  before((done) => {

    Group.create(groupData)
      .tap(g => group = g )
      .then(() => User.createMany(usersData))
      .then(results => {
        return Promise.map(results, (user, index) => {
          return group.addUserWithRole(user, usersData[index].role);
        });
      })
      .then(() => done())
      .catch(e => console.error);
  });
  
  it("forwards the email for approval to the core members", (done) => {
    request(app)
      .post('/webhooks/mailgun')
      .send(webhookBody)
      .then(() => done())
  });

});
const request = require('request');
const filter = require('lodash/collection/filter');
const values = require('lodash/object/values');
const errors = require('../lib/errors');
const Promise = require('bluebird');
const requestPromise = Promise.promisify(request, {multiArgs: true});

class Meetup {

  constructor(group) {
    this.group = group;
    this.settings = group.settings.meetup || {};
  }

  makeHeadersForTier(tiername) {
    const usersInTier = filter(values(this.group.users), { tier: tiername});
    let usersList = usersInTier.map((user) => (user.website) ? `<a href="${user.website}">${user.name}</a>` : user.name).join(', ');
    usersList = usersList.replace(/,([^,]*)$/,' and$1');
    const header = `<p>Thank you to our sponsors ${usersList}</p>\n<p><a href="https://opencollective.com/${this.group.slug}"><img src="https://opencollective.com/${this.group.slug}/${tiername}s.png?width=700"></a></p>`;
    return header;
  };

  updateMeetupDescription(eventId, description) {
    return requestPromise({
      url: `http://api.meetup.com/2/event/${eventId}?key=${this.settings.api_key}`,
      method: 'post',
      form: { description },
      json: true
    });
  }

  syncCollective() {

    if (!this.settings.url || !this.settings.api_key)
      return Promise.reject(new errors.ValidationFailed("url or api_key for meetup.com missing in the group's settings"));

    const urlname = this.settings.url.match(/\.com\/([^\/]+)/)[1];

    const reqopt = {
      url: `http://api.meetup.com/${urlname}/events?key=${this.settings.api_key}`,
      json: true
    };

    const descriptionHeader = this.makeHeadersForTier('sponsor');

    const promises = [];
    return requestPromise(reqopt).then(result => {
      const meetups = result[1];
      for (var i=0;i<meetups.length;i++) {
        var meetup = meetups[i];
        if (!meetup.description.match(new RegExp(`^${descriptionHeader.substr(0, 50)}`))) {
          promises.push(this.updateMeetupDescription(meetup.id, `${descriptionHeader}\n ${meetup.description}`));
        }
      }
      return Promise.all(promises).then(results => {
        return results.map((r) => r[1]);
      });
    });


  };

};

module.exports = Meetup;
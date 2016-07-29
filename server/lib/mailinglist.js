import config from 'config';
import MailgunJS from 'mailgun-js';

const debug = require('debug')('mailinglist');

class MailingList {

  constructor(group) {
    this.group = group;
    this.domain = group.settings.domain || `${group.slug}.opencollective.com`;
    this.mailgun = MailgunJS({ apiKey: config.mailgun.api_key, domain: this.domain });
    this.lists = {};
    this.init();
  }

  init() {
    this.getMailingLists();
  }

  getMailingLists() {
    this.mailgun.lists().list((err, res) => {
      res.items.map(list => {
        this.lists[list.address.substr(0,list.address.indexOf('@'))] = list;
      });
    })
  }

  createList(listname) {
    return new Promise((resolve, reject) => {
      debug("creating", listname);
      const result = { list: this.lists[listname], message: 'Mailing list already exists' };
      if (this.lists[listname]) return resolve(result);

      this.mailgun.lists().create({
        address: `${listname}@${this.domain}`,
        description: `Mailing list for all the ${listname} of ${this.group.name}`
      }, (err, res) => {
        if (err) {
          if (err.message === 'Duplicate object') return resolve(result);
          else return reject(err);
        }
        this.lists[listname] = res.list;
        return resolve(res);
      });
    });
  }

  destroyList(listname) {
    return new Promise((resolve, reject) => {
      debug("Destroying ", listname);
      this.mailgun.lists(`${listname}@${this.domain}`).delete((err, res) => {
          if (err) return reject(err);
          delete this.lists[listname];
          resolve(res);
      });
    });
  }

  destroyAllLists() {
    const promises = [];
    for (const listname in this.lists) {
      promises.push(this.destroyList(listname));
    }
    return Promise.all(promises);
  }

  addMemberToExistingList(user, listname) {
    return new Promise((resolve, reject) => {
      debug(`Adding ${user.email} to ${listname}`);
      this.mailgun.lists(`${listname}@${this.domain}`).members().create({
        address: user.email,
        name: user.name,
        subscribed: true,
        upsert: 'yes'
      }, (err, res) => {
          if (err) return reject(err);
          this.lists[listname].members_count++;
          res.list = this.lists[listname];
          resolve(res);
      });
    });
  };

  addMember(user, listname) {
    return this.createList(listname)
      .then(() => this.addMemberToExistingList(user, listname));
  };

  removeMember(user, listname) {
    debug(`Removing ${user.email} from ${listname}`);
    return new Promise((resolve, reject) => {
      this.mailgun.lists(`${listname}@${this.domain}`).members(user.email).delete((err, res) => {
          if (err) return reject(err);
          resolve(res);
      });
    });
  }

  syncCollective() {
    const promises = this.group.users.map(user => this.addMember(user, `${user.tier}s`))
    return Promise.all(promises);
  }

}

module.exports = MailingList;
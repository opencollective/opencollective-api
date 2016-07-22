/**
 * Dependencies.
 */
const request = require('request');
const filter = require('lodash/collection/filter');
const values = require('lodash/object/values');
const config = require('config');

/**
 * Controller.
 */
module.exports = (app) => {
    const errors = app.errors;

    const sync = (req, res, next) => {
        const meetupconfig = req.group.settings.meetup;

        if(!meetupconfig.api_key) {
            return next(new errors.ValidationFailed("api_key for meetup.com missing in the group's settings"));
        }
        const urlname = meetupconfig.url.match(/\.com\/([^\/]+)/)[1];
        
        const reqopt = {
            url: `http://api.meetup.com/${urlname}/events?key=${meetupconfig.api_key}`,
            json: true
        };

        req.backers = filter(values(req.users), { tier: 'backer'});
        req.sponsors = filter(values(req.users), { tier: 'sponsor'});
        const tiername = 'backers';
        const updateMeetupDescription = (eventId, description) => {
            const usersList = req[tiername].map((user) => (user.website) ? `<a href="${user.website}">${user.name}</a>` : user.name).join(', ');
            const header = `<p>Thank you to our sponsors ${usersList}</p>\n<p><a href="https://opencollective.com/${req.group.slug}"><img src="https://opencollective.com/${req.group.slug}/${tiername}.png?width=700"></a></p>`;

            //return res.send(header);
            if (description.match(new RegExp(`^${header}`))) {
              return res.send(req.backers);
            }
            var description = `${header} ${description}`;

            request({
              url: `http://api.meetup.com/2/event/${eventId}?key=${meetupconfig.api_key}`,
              method: 'post',
              form: { description },
              json: true
            }, (e, r, body) => {
              res.send(body);
            });
        }

        request(reqopt, (e, r, meetups) => {
            updateMeetupDescription(meetups[0].id, meetups[0].description)
        });

    }

    return { sync };

}
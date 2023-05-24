# Open Collective API

![CI](https://github.com/opencollective/opencollective-api/workflows/CI/badge.svg)
![E2E](https://github.com/opencollective/opencollective-api/workflows/E2E/badge.svg)

The Open Collective API is an interface that allows developers to interact programmatically with the Open Collective platform, providing a set of endpoints that developers can use to create, update, and retrieve information from Open Collective. It allows integration with external applications, such as custom dashboards, accounting systems, or automation tools, to interact with collective data.

With the Open Collective API, you can perform various actions, including:

1. Collectives: Retrieve information about collectives, create new ones, update existing collectives, and manage membership.
1. Financial Transactions: Retrieve financial transactions for a collective, create new transactions, and manage expenses.
1. Updates: Retrieve and create updates for collectives.
1. Donations: Retrieve information about donations made to a collective.
1. Webhooks: Set up event-based notifications to receive updates about specific actions or changes on collectives.

The API uses RESTful principles, and you can interact with it by making HTTP requests, typically using JSON as the data format. Detailed documentation about the Open Collective API, including endpoints, authentication, and usage examples, can be found on the [Open Collective](https://opencollective.com/) website.

Please amend the instructions below if you notice that steps could be improved or updated. We rarely go through this process ourselves, so fresh pairs of eyes and new experiences may assist in better informing others. Thank you!

## Development

### Prerequisite

1. Make sure you have Node.js version 18.x and NPM version 8.x.

- We recommend using [nvm](https://github.com/creationix/nvm): `nvm install && nvm use`.

2. Make sure you have a PostgreSQL database available

- Check the version: 11.0, 10.3, 9.6.8, 9.5.12, 9.4.17, 9.3.22 or newer
- More info in our [PostgreSQL Database](docs/postgres.md) documentation

3. For [node-gyp](https://github.com/nodejs/node-gyp), make sure you have Python 2 available and configured as the active version.

- You can use [pyenv](https://github.com/pyenv/pyenv) to manage Python versions.

### Install

We recommend cloning the repository in a folder dedicated to `opencollective` projects.

```
git clone git@github.com:opencollective/opencollective-api.git opencollective/api
cd opencollective/api
npm install
```

### Start

```
npm run dev
```

- API is started on http://localhost:3060
- A local email inbox is started on http://localhost:1080

See the [dev docs](docs/dev.md) for querying basics.

#### Troubleshooting

- If you're running into `node-gyp` issues related to Python 3 vs Python 2, you can run: `npm rebuild`
- If you have issues with PostgreSQL, check our [dedicated documentation](docs/postgres.md)

## Deployment

**Summary**: This project is currently deployed to staging and production with [Heroku](https://www.heroku.com/). To deploy, you need to be a core member of the Open Collective team.

See: [docs/deployment.md](docs/deployment.md)

## More documentation:

- [PostgreSQL Database](docs/postgres.md)
- [List of supported environment variables](docs/environment_variables.md)
- [Developing with Emails](docs/emails.md)
- [Data Exports](docs/data_exports.md)

## Discussion

If you have any questions, ping us on Slack
(https://slack.opencollective.com) or on Twitter
([@opencollect](https://twitter.com/opencollect)).

## License

[MIT](LICENSE)

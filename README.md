# Open Collective API

![CI](https://github.com/opencollective/opencollective-api/workflows/CI/badge.svg)
![E2E](https://github.com/opencollective/opencollective-api/workflows/E2E/badge.svg)
[![Discord](https://discordapp.com/api/guilds/1241017531318276158/widget.png)](https://discord.opencollective.com)

## Foreword

If you see a step below that could be improved (or is outdated), please update the instructions. We rarely go through this process ourselves, so your fresh pair of eyes and your recent experience with it, makes you the best candidate to improve them for other users. Thank you!

## Development

### Prerequisite

1. Make sure you have Node.js version 20.x and NPM version 10.x.

- We recommend using [nvm](https://github.com/creationix/nvm): `nvm install && nvm use`.

2. Make sure you have a PostgreSQL database available

- Check the version: 14.x or newer
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

### Running tests

To setup the test database, run `npm run db:restore:test`.

Tests can then be run with `npm run test` or `npm run test:watch` (watch mode). Since the full test suite can be quite heavy, we recommend passing the files you want to test as arguments to the command:

```bash
npm run test test/server/models/SocialLink.test.ts
```

## Deployment

**Summary**: This project is currently deployed to staging and production with [Heroku](https://www.heroku.com/). To deploy, you need to be a core member of the Open Collective team.

See: [docs/deployment.md](docs/deployment.md)

## More documentation:

- [PostgreSQL Database](docs/postgres.md)
- [List of supported environment variables](docs/environment_variables.md)
- [Developing with Emails](docs/emails.md)

## Discussion

If you have any questions, ping us on [Discord](https://discord.opencollective.com).

## License

[MIT](LICENSE)

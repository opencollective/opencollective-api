<<<<<<< HEAD
![logo](https://opencollective.com/public/images/opencollectivelogo.svg)

Please raise all issues in this repo, which serves as an overview for the project.

[![Slack Status](https://slack.opencollective.com/badge.svg)](https://slack.opencollective.com)
[![Crowdin](https://badges.crowdin.net/opencollective/localized.svg)](https://crowdin.com/project/opencollective)

## What is OpenCollective?

Open Collective is an online funding platform for open and transparent communities. We provide the tools to raise money and share your finances in full transparency.

## Documentation

Please see our help docs for all info, including user guide, how to contribute, and developer docs: https://docs.opencollective.com

## Issues

This repository serves as [our main issue tracker](https://github.com/opencollective/opencollective/issues). When creating issues, it's important to follow common guidelines to make them extra clear. Here is a few links that we liked to help you achieve that:

- [GitHub Guides: Mastering Issues](https://guides.github.com/features/issues/)
- [Wiredcraft: How We Write Github Issues](https://wiredcraft.com/blog/how-we-write-our-github-issues/)
- [NYC Planning Digital: Writing Useful Github Issues](https://medium.com/nyc-planning-digital/writing-a-proper-github-issue-97427d62a20f)

## Questions?

Join [our Slack](https://slack.opencollective.com) or [email support](mailto:support@opencollective.com).
=======
# Open Collective API

[![Slack Status](https://slack.opencollective.org/badge.svg)](https://slack.opencollective.org)
[![Dependency Status](https://david-dm.org/opencollective/opencollective-api.svg)](https://david-dm.org/opencollective/opencollective-api)
[![Coverage Status](https://coveralls.io/repos/github/OpenCollective/opencollective-api/badge.svg)](https://coveralls.io/github/OpenCollective/opencollective-api)

## Foreword

If you see a step below that could be improved (or is outdated), please update the instructions. We rarely go through this process ourselves, so your fresh pair of eyes and your recent experience with it, makes you the best candidate to improve them for other users. Thank you!

## Development

### Prerequisite

1. Make sure you have Node.js version >= 10.

- We recommend using [nvm](https://github.com/creationix/nvm): `nvm use`.

2. Make sure you have a PostgreSQL database available

- Check the version: 11.0, 10.3, 9.6.8, 9.5.12, 9.4.17, 9.3.22 or newer
- Check that the [PostGIS](https://postgis.net/install/) extension is available
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
(https://slack.opencollective.org) or on Twitter
([@opencollect](https://twitter.com/opencollect)).
>>>>>>> 3a81dccb34c1be99fca82c9fde4a56cc0b41b632

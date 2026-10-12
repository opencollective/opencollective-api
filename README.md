# Open Collective API

[![Discord](https://discordapp.com/api/guilds/1241017531318276158/widget.png)](https://discord.opencollective.com)

## Foreword

If you see a step below that could be improved (or is outdated), please update the instructions. We rarely go through this process ourselves, so your fresh pair of eyes and your recent experience with it, makes you the best candidate to improve them for other users. Thank you!

## Development

### Prerequisite

1. Make sure you have Node.js version 24.x and NPM version 11.x.

- We recommend using [nvm](https://github.com/creationix/nvm): `nvm install && nvm use`.

2. Make sure you have a PostgreSQL database available

- Check the version: 16.x or newer
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

If your setup requires some specific values (e.g. custom database URL), create a `.env.test` file in the root of the project and set the values there.

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

### Turborepo tasks and CI cache

Use the usual commands: `npm run dev`, `npm run build`, `npm run lint`,
`npm run type:check`, `npm run format:check`, and `npm test`. These entrypoints
run through Turbo by default. Forward runner arguments as usual, for example
`npm test -- path/to/test.ts`. Internal `:task` scripts contain the underlying
commands so workspace orchestration never recursively invokes Turbo. For advanced
Turbo options, use `npm run turbo -- run lint:task type:check:task --dry=json`.
The build command runs the
Turbo compilation graph and always refreshes Cloudflare IP ranges afterward.
Development and database/E2E tasks are not cached. Standalone `npm ci` and Heroku
entrypoints remain supported; the parent workspace keeps separate installs.

Remote Cache uses GitHub OIDC and the existing `TURBO_TEAM` Actions variable.
In Vercel team Settings → Build and Deployment → OIDC Policies for CLI Access,
create Turborepo CLI policies for `opencollective/opencollective-api` and
`opencollective/opencollective-frontend`. Keep each policy restricted to its
repository and CI/E2E workflows, including frontend's `e2e-prepare.yml` reusable
workflow. Allow repository branch pushes and pull-request claims; remove any
main-only branch restriction. API E2E runs on branch pushes. Leave the audience
at its default. Update existing policies instead of adding overlapping ones.

Jobs grant `id-token: write`. Vercel's setup action exchanges GitHub's OIDC token
for a short-lived `TURBO_TOKEN` before Turbo runs and revokes it when the job ends.
No `TURBO_TOKEN` repository secret is required. Authentication and remote cache
reads/writes run on repository branch pushes and PRs whose head repository
matches the workflow repository. Fork PRs, tag pushes, other events, and runs
without `TURBO_TEAM` use local caching. An OIDC policy mismatch fails the setup step.
Cache entries include source, lockfile, environment configuration, and declared
outputs.

See https://turborepo.dev/docs/crafting-your-repository/constructing-ci and
https://vercel.com/docs/monorepos/remote-caching/external-ci-cd#create-an-oidc-policy.

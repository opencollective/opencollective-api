# Deployment

To deploy to staging or production, you need to be a core member of the Open Collective team.

## Install the Heroku CLI

`pnpm install -g heroku`

## Login on the Heroku CLI

`heroku login`

## (Optional) Configure Slack Deployment Webhook

Setting a Slack webhook will post a message on `#deployments` channel with the changes you're about to deploy. It is not required, but you can activate it as folows.

Contact another [core team member](https://github.com/orgs/opencollective/teams/core-developers) to ask them for the link or, if you have admins permission on it, go to https://api.slack.com/apps/A017TDR2R61/incoming-webhooks and copy the link for `#deployments` channel.

Finally add this link to your `.env` file:

```bash
OC_SLACK_DEPLOY_WEBHOOK=<link-url>
```

## Deploy on staging

```bash
# Before first deployment, configure staging remote
git remote add staging https://git.heroku.com/opencollective-staging-api.git

# Then deploy main with
pnpm deploy:staging
```

URL: https://api-staging.opencollective.com/

## Deploy on production

```bash
# Before first deployment, configure production remote
git remote add production https://git.heroku.com/opencollective-prod-api.git

# Then deploy main with
pnpm deploy:production
```

URL: https://api.opencollective.com/

## Rollback Deployment to Previous State

If something goes wrong, you can easily rollback the deployment with the following commands.

```bash
heroku releases --app opencollective-prod-api
```

**Note:** For staging it will be, `heroku releases --app opencollective-staging-api`

This will give an output of all the Heroku releases. Something like,

```bash
=== opencollective-prod-api Releases - Current: v1574
v1574  Dep…         abc@opencollective.com        2021/07/21 11:09:08 -0700 (~ 26m ago)
v1573  Dep…         def@opencollective.com        2021/07/16 10:11:50 -0700
v1572  Dep…         ghi@opencollective.com        2021/07/15 08:23:19 -0700
v1571  Dep…         jkl@opencollective.com        2021/07/14 09:27:05 -0700
v1570  Dep…         mno@opencollective.com        2021/07/13 18:08:05 -0700
```

Now to rollback the latest deployment all you got to do is:

```bash
heroku rollback v1574 --app opencollective-prod-api
```

**Note:** For staging it will be, `heroku rollback v1574 --app opencollective-staging-api`

For more info refer to: https://blog.heroku.com/releases-and-rollbacks and https://devcenter.heroku.com/articles/releases#rollback

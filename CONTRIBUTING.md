# Contributing

## Bounties

This repo is part of the Open Collective bounty program. Get paid to contribute to Open Source! The Open Collective engineering team is small and we're always looking for new contributors to our Open Source codebases. Our Bounty program is an opportunity to solve issues that could be neglected otherwise. Contributors who fix these issues will be rewarded financially. Please see our docs for more information: https://docs.opencollective.com/help/contributing/development/bounties

## To fork or not to fork

If you want to change a simple thing, for example, fix a typo or update copy, feel free to use the GitHub web interface, that's perfect. Under the hood, it will do complex things but you don't need to think about it!

## Style

For formatting and code style, we use [Prettier](https://prettier.io/) and [ESLint](https://eslint.org/). Before committing, please run:

- `pnpm prettier:write`
- `pnpm lint:fix`

For the long run, we suggest to integrate these tools in your favorite code editor:

- check [Prettier Editor Integration](https://prettier.io/docs/en/editors.html)
- check [ESLint Editor Integrations](https://eslint.org/docs/user-guide/integrations)

## Commit convention

Your commit messages should conform to the [Conventional Commits](https://www.conventionalcommits.org/) specification.

To help you follow this convention, this project is using [commitizen](https://github.com/commitizen/cz-cli). To use it:

1. run `git add` first to add your changes to Git staging area
2. use `pnpm commit` to commit

Note: it's not mandatory to always commit with this tool (we don't), but it's great to get introduced to the commit conventions.

## Git guidelines

We do aim having a clean Git history! When submitting a Pull Request, make sure:

- each commit make sense and have a self-explaining message
- there is no unnecessary commits (such as "typo", "fix", "fix again", "eslint", "eslint again" or merge commits)

Some tips to keep a clean Git history while working on your feature branch:

- always update from main with `git pull --rebase origin main` or similar
- you might have to `git push origin --force`, that's all right if you're the only one working on the feature branch
- `git commit --amend` to modify your last commit with "fix", "typo", "prettier" or "eslint" modifications
- `git rebase --interactive` to rewrite the history

We understand Git is not always easy for everyone and want to be inclusive. If it's difficult for you to submit a Pull request with a clean Git history, that's all right, we can always [squash and merge](https://help.github.com/articles/about-pull-request-merges/#squash-and-merge-your-pull-request-commits) it.

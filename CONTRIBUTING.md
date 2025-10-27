# Contributions

🎉 Thanks for considering contributing to this project! 🎉

When contributing to this repository, please first discuss the change you wish to make via an
[issue](https://github.com/opennextjs/opennextjs-netlify/issues/new/choose). Please use the issue
templates. They are there to help you and to help the maintainers gather information.

Before working on an issue, ask to be assigned to it. This makes it clear to other potential
contributors that someone is working on the issue.

When creating a PR, please use the template. The information in the template helps maintainers
review your pull request.

This project was made with ❤️. The simplest way to give back is by starring and sharing it online.

## Development process

First fork and clone the repository. If you're not sure how to do this, please watch
[these videos](https://egghead.io/courses/how-to-contribute-to-an-open-source-project-on-github).

Run:

```bash
npm install
```

Make sure everything is correctly setup with:

```bash
npm test
```

## Lambda Folder structure

For a simple next.js app

```
/___netlify-server-handler
├── .netlify
│   └── dist // the compiled runtime code
│       └── run
│           ├── handlers
│           │   ├── server.js
│           │   └── cache.cjs
│           └── next.cjs
├── .next // or distDir name from the next.config.js
│   └── // content from standalone
├── run-config.json // the config object from the required-server-files.json
├── node_modules
├── ___netlify-server-handler.json
├── ___netlify-server-handler.mjs
└── package.json
```

## Testing

The repo includes three types of tests: e2e tests in the repo that use Playwright, integration and
unit tests that use Vitest.

By default the e2e, integration and unit tests run against the latest version of Next.js. To run
tests against a specific version, set the `NEXT_VERSION` environment variable to the desired
version.

By default, PRs will run the tests against the latest version of Next.js. To run tests against
`latest`, `canary`, `14.2.15`,`and`13.5.1`, apply the`test all versions` label to the PR when you
create it. These also run nightly and on release PRs.

### Integration testing

> **Prerequisite** Run `npm run build` before running integration tests.

How to add new integration test scenarios to the application:

1. Create a new folder under `tests/fixtures/<your-name>`
2. Adapt the `next.config.js` to be a standalone application
3. Create a `postinstall` script that runs the `next build`. It's important to notice that the
   integration tests rely on a already built next.js application in this folder. They rely on the
   `.next` folder.
4. Add your test

> Currently the tests require a built version of the `dist/run/handlers/cache.cjs` so you need to
> run `npm run build` before executing the integration tests.

In addition, the integration tests need to be prepared before first use. You can do this by running
`npm run pretest`. To speed up this process and build only the fixtures whose name starts with a
given prefix, run `npm run pretest -- <prefix>`.

### E2E testing

> **Prerequisite**
>
> Needs the `netlify-cli` installed and being logged in having access to Netlify Testing
> Organization or providing your own site ID with NETLIFY_SITE_ID environment variable.

The e2e tests can be invoked with `npm run e2e` and perform a full e2e test. This means they do the
following:

1. Building the adapter (just running `npm run build` in the repository)
2. Creating a temp directory and copying the provided fixture over to the directory.
3. Packing the runtime with `npm pack` to the temp directory.
4. Installing the runtime from the created zip artifact of `npm pack` (this is like installing a
   node_module from the registry)
5. Creating a `netlify.toml` inside the temp directory of the fixture and adding the runtime as a
   plugin.
6. Running `netlify deploy` invoking the runtime during the build step. This will use the
   [next-runtime-testing](https://app.netlify.com/sites/next-runtime-testing/overview) as site to
   deploy to.
7. Using the `deployId` and `url` of the deployed site to run some
   [playwright](https://playwright.dev/) tests against, asserting the correctness of the runtime.
8. After the tests where run successfully, it will delete the deployment again and clean everything
   up. In case of a failure, the deploy won't be cleaned up to leave it for troubleshooting
   purposes.

> [!TIP] If you'd like to always keep the deployment and the local fixture around for
> troubleshooting, run `E2E_PERSIST=1 npm run e2e`.

### Next.js tests

There is a GitHub workflow that runs the e2e tests from the Next.js repo against this repo. There is
also a script to run these tests locally that is run from this repo with
`./run-local-test.sh your-test-pattern-here`. It requires that `next.js` is checked out in the same
parent directory as this repo and built with `pnpm run build`.

#### cleanup old deploys

To cleanup old and dangling deploys from failed builds you can run the following script:

```bash
npx tsx ./tools/e2e/cleanup-deploys.ts
```

This will cleanup all created deploys on the
[next-runtime-testing](https://app.netlify.com/sites/next-runtime-testing/overview) site.

## How to write commit messages

We use [Conventional Commit messages](https://www.conventionalcommits.org/) to automate version
management.

Most common commit message prefixes are:

- `fix:` which represents bug fixes, and generate a patch release.
- `feat:` which represents a new feature, and generate a minor release.
- `feat!:`, `fix!:` or `refactor!:` and generate a major release.

## How to make a minimal reproduction

A reproducible test case is a small Next.js site built to demonstrate a problem - often this problem
is caused by a bug in Next.js, @opennextjs/netlify or user code. Your reproducible test case should
contain the bare minimum features needed to clearly demonstrate the bug.

Steps to create a reproducible test case:

- Create a new Next.js site: `npx create-next-app@latest`
- Add any code or functionality related to the issue. For example, if you have problems with
  middleware functionality you should add all the necessary code of your middleware.
- Verify that you're seeing the expected error(s) when running `netlify serve` and on a deployed
  version on [Netlify](https://www.netlify.com)
- Publish the code (your GitHub account is a good place to do this) and then link to it when
  creating an issue. While creating the issue, please give as many details as possible. This could
  also include screenshots of error messages.

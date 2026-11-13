export const PACKAGE_JSON =
  JSON.stringify(
    {
      name: 'app',
      version: '1.0.0',
      dependencies: { express: '^4.17.1', lodash: '^4.17.20' },
      devDependencies: { jest: '^29.0.0' },
    },
    null,
    2,
  ) + '\n';

export const LOCKFILE = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', dependencies: { express: '^4.17.1', lodash: '^4.17.20' }, devDependencies: { jest: '^29.0.0' } },
    'node_modules/express': { version: '4.17.1', dependencies: { qs: '6.7.0', 'body-parser': '1.19.0' } },
    'node_modules/body-parser': { version: '1.19.0', dependencies: { qs: '6.7.0' } },
    'node_modules/qs': { version: '6.7.0' },
    'node_modules/lodash': { version: '4.17.20' },
    'node_modules/jest': { version: '29.0.0', dev: true, dependencies: { lodash: '^4.17.0', minimist: '^1.2.0' } },
    'node_modules/minimist': { version: '1.2.0', dev: true },
    'node_modules/jest/node_modules/qs': { version: '6.5.0', dev: true },
  },
});

export const LODASH_TICKET = `Affected package: lodash
Installed version: 4.17.20
Fixed in: 4.17.21
Severity: high
CVE-2021-23337`;

export const QS_TICKET = `Affected package: qs
Vulnerable versions: <6.7.3
Fixed in: 6.7.3
Severity: high
GHSA-hrpp-h998-j3pp`;

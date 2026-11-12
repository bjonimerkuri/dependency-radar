export const POPULAR_PACKAGES: readonly string[] = [
  'react', 'react-dom', 'react-router', 'react-router-dom', 'react-redux', 'redux', 'react-scripts', 'react-native', 'react-query',
  'react-hook-form', 'react-select', 'react-icons', 'react-bootstrap', 'react-helmet', 'react-is', 'react-transition-group',
  'vue', 'vuex', 'vue-router', 'nuxt', 'next', 'svelte', 'angular', 'jquery', 'backbone', 'ember-source', 'preact', 'solid-js', 'lit',
  'lodash', 'underscore', 'ramda', 'immer', 'immutable', 'rxjs', 'zustand', 'mobx', 'jotai', 'recoil', 'swr',
  'express', 'koa', 'fastify', 'hapi', 'restify', 'nestjs', 'body-parser', 'cookie-parser', 'cors', 'helmet', 'morgan', 'multer',
  'compression', 'express-session', 'express-validator', 'serve-static', 'http-proxy', 'http-errors', 'cookie', 'passport', 'jsonwebtoken',
  'bcrypt', 'bcryptjs', 'argon2', 'crypto-js', 'uuid', 'nanoid', 'shortid', 'validator', 'joi', 'yup', 'zod', 'ajv', 'superstruct',
  'axios', 'node-fetch', 'got', 'superagent', 'request', 'request-promise', 'form-data', 'isomorphic-fetch', 'cross-fetch', 'undici', 'ws',
  'socket.io', 'socket.io-client', 'mongoose', 'mongodb', 'mysql', 'mysql2', 'pg', 'sqlite3', 'sequelize', 'typeorm', 'prisma', 'knex',
  'redis', 'ioredis', 'graphql', 'apollo-server', 'apollo-client', 'graphql-tag', 'moment', 'moment-timezone', 'dayjs', 'luxon', 'date-fns',
  'chalk', 'colors', 'picocolors', 'kleur', 'ansi-styles', 'strip-ansi', 'supports-color', 'commander', 'yargs', 'minimist', 'meow',
  'inquirer', 'prompts', 'ora', 'boxen', 'cli-table', 'dotenv', 'debug', 'winston', 'pino', 'bunyan', 'log4js', 'loglevel',
  'async', 'bluebird', 'q', 'promise', 'p-limit', 'p-map', 'p-queue', 'eventemitter3', 'events', 'tslib', 'core-js', 'regenerator-runtime',
  'typescript', 'ts-node', 'tsx', 'ts-jest', 'eslint', 'prettier', 'stylelint', 'babel-core', 'babel-loader', 'babel-eslint', 'jest', 'mocha',
  'chai', 'sinon', 'jasmine', 'karma', 'ava', 'tape', 'cypress', 'playwright', 'puppeteer', 'selenium-webdriver', 'supertest', 'nock',
  'webpack', 'webpack-cli', 'webpack-dev-server', 'rollup', 'vite', 'esbuild', 'parcel', 'gulp', 'grunt', 'browserify', 'terser', 'uglify-js',
  'postcss', 'autoprefixer', 'sass', 'node-sass', 'less', 'tailwindcss', 'css-loader', 'style-loader', 'sass-loader', 'file-loader',
  'html-webpack-plugin', 'mini-css-extract-plugin', 'copy-webpack-plugin', 'classnames', 'prop-types', 'styled-components', 'emotion',
  'fs-extra', 'glob', 'globby', 'rimraf', 'mkdirp', 'chokidar', 'del', 'cpy', 'shelljs', 'execa', 'cross-env', 'cross-spawn', 'nodemon',
  'concurrently', 'npm-run-all', 'husky', 'lint-staged', 'semver', 'minimatch', 'micromatch', 'path-to-regexp', 'qs', 'query-string',
  'iconv-lite', 'safe-buffer', 'buffer', 'readable-stream', 'through2', 'xml2js', 'cheerio', 'jsdom', 'marked', 'markdown-it', 'highlight.js',
  'handlebars', 'ejs', 'pug', 'mustache', 'nunjucks', 'sharp', 'jimp', 'canvas', 'multer', 'archiver', 'adm-zip', 'tar', 'yaml', 'js-yaml',
  'papaparse', 'csv-parse', 'xlsx', 'pdfkit', 'bootstrap', 'popper.js', 'font-awesome', 'animate.css', 'normalize.css', 'three', 'd3',
  'chart.js', 'moment-locales-webpack-plugin', 'faker', 'chance', 'json5', 'ini', 'rc', 'which', 'open', 'opn', 'ncp', 'nopt', 'tmp',
];

const POPULAR_SET: ReadonlySet<string> = new Set(POPULAR_PACKAGES);

const LEGIT_PAIRS: ReadonlySet<string> = new Set([
  'color|colors', 'colors|color', 'react-dom|react-doms', 'debug|debugs', 'mime|mimes', 'ajv|ajvs',
  'ora|orb', 'got|gots', 'ws|wss', 'mkdirp|mkdir', 'glob|globs', 'chai|chain', 'sass|sas', 'less|lest',
  'async|asyncs', 'jest|jets', 'prop-types|proptypes', 'tape|tap', 'open|opn', 'vite|vitest', 'vite|vue',
]);

export interface Lookalike {
  popular: string;
  kind: 'separator' | 'edit' | 'case';
}

function squash(name: string): string {
  return name.replace(/[-_.]/g, '');
}

function distanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return i + 1 < a.length && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

export function isPopularPackage(name: string): boolean {
  return POPULAR_SET.has(name);
}

export function findLookalike(name: string): Lookalike | undefined {
  if (name.startsWith('@') || POPULAR_SET.has(name)) return undefined;
  const lower = name.toLowerCase();
  const squashed = squash(lower);

  for (const popular of POPULAR_PACKAGES) {
    if (popular.length < 5) continue;
    if (lower === popular) return { popular, kind: 'case' };
    if (squashed === squash(popular) && lower !== popular) return { popular, kind: 'separator' };
  }
  if (lower.length < 5) return undefined;
  for (const popular of POPULAR_PACKAGES) {
    if (popular.length < 5 || LEGIT_PAIRS.has(`${popular}|${lower}`)) continue;
    if (distanceAtMostOne(lower, popular)) return { popular, kind: 'edit' };
  }
  return undefined;
}

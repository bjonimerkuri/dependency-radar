import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanTextForRisks } from '../src/index.ts';

const ids = (text: string, executable: boolean) => scanTextForRisks(text, { executable }).map((match) => match.id).sort();

describe('scanTextForRisks', () => {
  it('finds nothing in ordinary application code', () => {
    const code = "const express = require('express');\nconst app = express();\napp.get('/', (req, res) => res.send('hi'));\napp.listen(3000);\n";
    assert.deepEqual(ids(code, false), []);
  });

  it('flags code that runs decoded text in any file', () => {
    for (const code of ["eval(atob('YWxlcnQoMSk='));", "eval(Buffer.from(data, 'base64').toString());", "new Function(atob(x))();"]) {
      const result = scanTextForRisks(code, { executable: false });
      assert.equal(result[0]?.id, 'code-decode-eval', code);
      assert.equal(result[0]?.severity, 'high');
    }
  });

  it('only flags eval, system commands and network use in files that run on build or start', () => {
    const code = "const cp = require('child_process');\ncp.execSync('ls');\neval(x);\nconst https = require('https');\nhttps.get(url);\n";
    assert.deepEqual(ids(code, false), []);
    assert.deepEqual(ids(code, true), ['code-child-process', 'code-eval', 'code-network']);
  });

  it('flags the signature of common obfuscators', () => {
    const code = Array.from({ length: 6 }, (_, i) => `var _0x${(0x1a2b + i).toString(16)} = [];`).join('\n');
    const result = scanTextForRisks(code, { executable: false });
    assert.equal(result.length, 1);
    assert.equal(result[0]?.id, 'code-obfuscated');
    assert.equal(result[0]?.severity, 'high');
    assert.equal(result[0]?.line, 1);
  });

  it('flags hex escapes, character codes, encoded blobs and very long lines', () => {
    assert.ok(ids('var a = "' + '\\x41'.repeat(45) + '";', false).includes('code-hex-escapes'));
    assert.ok(ids(`var a = String.fromCharCode(${Array.from({ length: 30 }, (_, i) => 100 + i).join(', ')});`, false).includes('code-char-codes'));
    assert.ok(ids(`var blob = "${'QUJD'.repeat(100)}";`, false).includes('code-base64-blob'));
    assert.ok(ids('x'.repeat(2500), false).includes('code-long-line'));
  });

  it('makes an encoded blob high severity when the file also runs text as code', () => {
    const result = scanTextForRisks(`var blob = "${'QUJD'.repeat(100)}";\neval(decode(blob));`, { executable: false });
    assert.equal(result.find((match) => match.id === 'code-base64-blob')?.severity, 'high');
  });

  it('flags chat webhooks, raw IP addresses and drop sites', () => {
    assert.equal(scanTextForRisks("post('https://discord.com/api/webhooks/1/abc');", { executable: true })[0]?.severity, 'high');
    assert.equal(scanTextForRisks("post('https://discord.com/api/webhooks/1/abc');", { executable: false })[0]?.severity, 'medium');
    assert.ok(ids("fetch('http://203.0.113.9:8080/x')", false).includes('code-ip-url'));
    assert.ok(ids("get('https://pastebin.com/raw/abc')", false).includes('code-drop-site'));
  });

  it('does not flag private addresses', () => {
    for (const address of ['http://127.0.0.1:3000', 'http://192.168.1.10/api', 'http://10.0.0.5', 'http://172.20.1.1', 'http://0.0.0.0:8080']) {
      assert.deepEqual(ids(`fetch('${address}')`, false), [], address);
    }
  });

  it('flags code that looks for credentials or wallets', () => {
    const both = "const key = fs.readFileSync(os.homedir() + '/.ssh/id_rsa');\nconst w = '/Library/Application Support/Exodus';\n";
    const result = scanTextForRisks(both, { executable: false });
    assert.equal(result.find((match) => match.id === 'code-credentials')?.severity, 'high');
    assert.deepEqual(ids("read('.npmrc')", false), []);
    assert.equal(scanTextForRisks("read('.npmrc')", { executable: true })[0]?.severity, 'medium');
  });

  it('notes code that reads every environment variable', () => {
    assert.deepEqual(ids('send(JSON.stringify(process.env));', false), ['code-env-dump']);
  });

  it('reports the line and a short excerpt', () => {
    const result = scanTextForRisks("// header\n\neval(atob('abc'));\n", { executable: false });
    assert.equal(result[0]?.line, 3);
    assert.equal(result[0]?.excerpt, "eval(atob('abc'));");
  });

  it('reports each kind of finding once per file', () => {
    const code = "eval(atob('a'));\neval(atob('b'));\neval(atob('c'));\n";
    assert.equal(scanTextForRisks(code, { executable: false }).length, 1);
  });

  it('stays fast on large and awkward input', () => {
    const started = Date.now();
    scanTextForRisks('a'.repeat(1_000_000), { executable: true });
    scanTextForRisks('eval('.repeat(100_000), { executable: true });
    scanTextForRisks('QUJD'.repeat(250_000), { executable: true });
    scanTextForRisks('\\x41'.repeat(200_000), { executable: true });
    scanTextForRisks(('_0x1a2b3c ' + '.ssh ').repeat(100_000), { executable: true });
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  });
});

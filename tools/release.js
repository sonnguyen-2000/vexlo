'use strict';
/* One command to ship: tests -> bump version -> git add + commit (your message) -> push -> tag -> push tag.
 * The tag makes GitHub Actions build the installer and publish the release.
 *   npm run ship                          asks for the bump and the commit message
 *   npm run ship -- patch "Fix updater"   patch | minor | major | 1.2.3  +  message
 */
const { execFileSync } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, shell: process.platform === 'win32' }).toString().trim();

function ask(q, def = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim() || def); }));
}

function bump(cur, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) { return how; }
  const [a, b, c] = cur.split('.').map(Number);
  if (how === 'major') { return `${a + 1}.0.0`; }
  if (how === 'minor') { return `${a}.${b + 1}.0`; }
  if (how === 'patch') { return `${a}.${b}.${c + 1}`; }
  throw new Error('Bump must be patch, minor, major or a version like 1.2.3');
}

(async () => {
  const pkgPath = path.join(root, 'package.json');
  const cur = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  const how = process.argv[2] || await ask(`Current version ${cur}. Bump (patch/minor/major or 1.2.3) [patch]: `, 'patch');
  const next = bump(cur, how);
  const msg = process.argv[3] || await ask('Commit message: ');
  if (!msg) { throw new Error('A commit message is required.'); }
  if (out('git', ['tag', '-l', `v${next}`])) { throw new Error(`Tag v${next} already exists.`); }
  const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);

  console.log(`\n== ${cur} -> ${next} on branch ${branch}\n== tests`);
  run('npm', ['test']);

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = next;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const lock = path.join(root, 'package-lock.json');
  if (fs.existsSync(lock)) {
    const l = JSON.parse(fs.readFileSync(lock, 'utf8'));
    l.version = next;
    if (l.packages && l.packages['']) { l.packages[''].version = next; }
    fs.writeFileSync(lock, JSON.stringify(l, null, 2) + '\n');
  }

  console.log('== commit and push');
  run('git', ['add', '-A']);
  run('git', ['commit', '-m', process.platform === 'win32' ? `"${msg.replace(/"/g, '\\"')}"` : msg]);
  run('git', ['push', 'origin', branch]);
  console.log(`== tag v${next} (GitHub Actions builds the release)`);
  run('git', ['tag', `v${next}`]);
  run('git', ['push', 'origin', `v${next}`]);
  console.log(`\nDone. Watch the build: Actions tab of your repository. Release: v${next}`);
})().catch((e) => { console.error('\nStopped: ' + e.message); process.exit(1); });

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
});
const candidates = output
  .split('\0')
  .filter(Boolean)
  .filter((candidate) => existsSync(resolve(root, candidate)));
const forbiddenArtifacts = /(?:^|\/)(?:recorder\.db(?:-(?:wal|shm))?|recorder\.db\.key|[^/]+\.afr)$/i;
const textExtensions = new Set([
  '',
  '.css',
  '.editorconfig',
  '.example',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);
const personalPathPatterns = [
  new RegExp('/' + 'Users/[^/<>{}$"\\s]+/'),
  new RegExp('/' + 'home/[^/<>{}$"\\s]+/'),
  new RegExp('[A-Za-z]:\\\\' + 'Users\\\\[^\\\\/<>{}$"\\s]+\\\\'),
];
const failures = [];

for (const candidate of candidates) {
  if (forbiddenArtifacts.test(candidate) || candidate.startsWith('.flight-recorder')) {
    failures.push(`${candidate}: private recorder artifact must remain ignored`);
    continue;
  }
  const path = resolve(root, candidate);
  if (!textExtensions.has(extname(candidate).toLowerCase()) || statSync(path).size > 2_000_000) continue;
  const content = readFileSync(path, 'utf8');
  for (const pattern of personalPathPatterns) {
    if (pattern.test(content)) failures.push(`${relative(root, path)}: contains an absolute user-home path`);
  }
}

if (failures.length > 0) {
  console.error('Public privacy check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Public privacy check passed for ${candidates.length} publishable files.`);
}

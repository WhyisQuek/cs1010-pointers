/**
 * Confirms the student build contains no Level editor code and the instructor build does.
 * Run after `npm run build` and `npm run build:instructor`. Checking the instructor build
 * too proves the markers still identify the editor, so the student check cannot pass
 * vacuously after a rename.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// String literals unique to LevelEditor.jsx that survive minification.
const MARKERS = ['pointerviz-levels.json', 'Save level'];

function builtText(dir) {
  let text = '';
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) text += builtText(path);
    else if (/\.(js|html|css)$/.test(name)) text += readFileSync(path, 'utf8');
  }
  return text;
}

function check(dir, expectEditor) {
  let text;
  try {
    text = builtText(dir);
  } catch {
    return [`${dir}/ not found; build it first`];
  }
  return MARKERS.filter(m => text.includes(m) !== expectEditor).map(m =>
    expectEditor ? `${dir}/ is missing Level editor marker "${m}"` : `${dir}/ contains "${m}"`,
  );
}

const problems = [...check('dist', false), ...check('dist-instructor', true)];
if (problems.length) {
  console.error(`Edition check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Edition check passed: the student build has no Level editor code.');

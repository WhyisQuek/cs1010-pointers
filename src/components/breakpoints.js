/**
 * Keeps breakpoints on the same code across an edit. Lines before and after the changed lines
 * keep their breakpoints (moving with the edit); of the changed lines, the first keeps its
 * breakpoint if it was edited rather than deleted, and the rest lose theirs.
 */
export function shiftBreakpoints(before, after, breakpoints) {
  if (!breakpoints.size || before === after) return breakpoints;
  const old = before.split('\n'),
    now = after.split('\n');
  let prefix = 0;
  while (prefix < old.length && prefix < now.length && old[prefix] === now[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(old.length, now.length) - prefix &&
    old.at(-1 - suffix) === now.at(-1 - suffix)
  )
    suffix++;
  const delta = now.length - old.length;
  const firstChanged = prefix + 1,
    lastChanged = old.length - suffix;

  const shifted = new Set();
  for (const line of breakpoints) {
    if (line < firstChanged) shifted.add(line);
    else if (line > lastChanged) shifted.add(line + delta);
    else if (line === firstChanged && now.length - suffix > prefix) shifted.add(line);
  }
  return shifted;
}

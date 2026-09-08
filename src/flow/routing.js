/** Orthogonal routes around allocation boxes and frame headers. No C semantics. */
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export function crossesBox(a, b, r) {
  if (a.x === b.x) return a.x > r.x && a.x < r.x + r.width && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.height;
  return a.y > r.y && a.y < r.y + r.height && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.width;
}

function simplify(points) {
  const out = [];
  for (const p of points) {
    if (out.length && distance(out.at(-1), p) === 0) continue;
    while (out.length > 1) {
      const a = out.at(-2), b = out.at(-1);
      if ((a.x === b.x && b.x === p.x || a.y === b.y && b.y === p.y) && distance(a, b) + distance(b, p) === distance(a, p)) out.pop();
      else break;
    }
    out.push(p);
  }
  return out;
}

export function routePointer(source, target, targetSide, obstacles, lane = 0) {
  const gap = 16 + (lane % 4) * 4;
  const start = { x: source.x + gap, y: source.y };
  const end = { x: target.x + (targetSide === 'right' ? gap : -gap), y: target.y };
  const xs = [...new Set([start.x, end.x, ...obstacles.flatMap(r => [r.x - gap, r.x + r.width + gap])])];
  const ys = [...new Set([start.y, end.y, ...obstacles.flatMap(r => [r.y - gap, r.y + r.height + gap])])];
  let best = null, bestScore = Infinity;
  const consider = middle => {
    const points = simplify([source, start, ...middle, end, target]);
    let score = points.length * 12;
    for (let i = 1; i < points.length; i++) {
      score += distance(points[i - 1], points[i]);
      // Overlapping manually placed boxes may make a clear route impossible.
      for (const box of obstacles) if (crossesBox(points[i - 1], points[i], box)) score += 100000;
    }
    if (score < bestScore) { best = points; bestScore = score; }
  };
  for (const x of xs) consider([{ x, y: start.y }, { x, y: end.y }]);
  for (const y of ys) consider([{ x: start.x, y }, { x: end.x, y }]);
  return best;
}

/** Rounded corners stay within the routing gutter. */
export function roundedPath(points, radius = 6) {
  if (!points?.length) return '';
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const r = Math.min(radius, distance(a, b) / 2, distance(b, c) / 2);
    const before = { x: b.x + Math.sign(a.x - b.x) * r, y: b.y + Math.sign(a.y - b.y) * r };
    const after = { x: b.x + Math.sign(c.x - b.x) * r, y: b.y + Math.sign(c.y - b.y) * r };
    path += ` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`;
  }
  return path + ` L ${points.at(-1).x} ${points.at(-1).y}`;
}


/** Orthogonal routes around allocation boxes and frame headers. No C semantics. */
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export function crossesBox(a, b, r) {
  let enter = 0,
    leave = 1;
  for (const [axis, size] of [
    ['x', 'width'],
    ['y', 'height'],
  ]) {
    const low = r[axis] + 1e-6,
      high = r[axis] + r[size] - 1e-6,
      delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-9) {
      if (a[axis] < low || a[axis] > high) return false;
    } else {
      const t1 = (low - a[axis]) / delta,
        t2 = (high - a[axis]) / delta;
      enter = Math.max(enter, Math.min(t1, t2));
      leave = Math.min(leave, Math.max(t1, t2));
      if (enter > leave) return false;
    }
  }
  return enter <= leave;
}

function simplify(points) {
  const out = [];
  for (const p of points) {
    if (out.length && distance(out.at(-1), p) === 0) continue;
    while (out.length > 1) {
      const a = out.at(-2),
        b = out.at(-1);
      if (
        ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) &&
        distance(a, b) + distance(b, p) === distance(a, p)
      )
        out.pop();
      else break;
    }
    out.push(p);
  }
  return out;
}

export function routePointer(
  source,
  target,
  targetSide,
  obstacles,
  lane = 0,
  sourceSide = 'right',
) {
  const gap = 16 + (lane % 4) * 4;
  const start = { x: source.x + (sourceSide === 'right' ? gap : -gap), y: source.y };
  const end = { x: target.x + (targetSide === 'right' ? gap : -gap), y: target.y };
  const xs = [
    ...new Set([start.x, end.x, ...obstacles.flatMap(r => [r.x - gap, r.x + r.width + gap])]),
  ];
  const ys = [
    ...new Set([start.y, end.y, ...obstacles.flatMap(r => [r.y - gap, r.y + r.height + gap])]),
  ];
  let best = null,
    bestScore = Infinity;
  const consider = middle => {
    const points = simplify([source, start, ...middle, end, target]);
    let score = points.length * 12;
    for (let i = 1; i < points.length; i++) {
      score += distance(points[i - 1], points[i]);
      // Overlapping manually placed boxes may make a clear route impossible.
      for (const box of obstacles) if (crossesBox(points[i - 1], points[i], box)) score += 100000;
    }
    if (score < bestScore) {
      best = points;
      bestScore = score;
    }
  };
  for (const x of xs)
    consider([
      { x, y: start.y },
      { x, y: end.y },
    ]);
  for (const y of ys)
    consider([
      { x: start.x, y },
      { x: end.x, y },
    ]);
  return best;
}

function cubic(a, b, c, d, t) {
  const u = 1 - t;
  return {
    x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
    y: u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y,
  };
}

// Every arrow arrives along this straight run, so arrows to one spot merge into one line.
const ARRIVAL = 20;

/** Adaptive curves; manual bends are offsets from the endpoint midpoint. */
export function curvePointer(
  source,
  target,
  sourceSide,
  targetSide,
  obstacles,
  offset,
  self = false,
) {
  const midpoint = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  const reach = Math.max(48, Math.min(180, Math.abs(target.x - source.x) * 0.45));
  const first = { x: source.x + (sourceSide === 'right' ? reach : -reach), y: source.y };
  const outward = targetSide === 'right' ? 1 : -1;
  const arrival = { x: target.x + outward * ARRIVAL, y: target.y };
  const last = { x: arrival.x + outward * reach, y: target.y };
  function candidate(bend) {
    let segments;
    if (!bend) segments = [[source, first, last, arrival]];
    else {
      const dx = target.x - source.x,
        dy = target.y - source.y,
        length = Math.hypot(dx, dy) || 1;
      // A self-pointer passes its bend heading for its target, or it doubles back into a knot.
      const tangent = self
        ? { x: 0, y: dy < 0 ? -48 : 48 }
        : { x: (dx / length) * 40, y: (dy / length) * 40 };
      segments = [
        [source, first, { x: bend.x - tangent.x, y: bend.y - tangent.y }, bend],
        [bend, { x: bend.x + tangent.x, y: bend.y + tangent.y }, last, arrival],
      ];
    }
    const points = [
      ...segments.flatMap(s => Array.from({ length: 33 }, (_, i) => cubic(...s, i / 32))),
      target,
    ];
    const path =
      `M ${source.x} ${source.y}` +
      segments.map(s => ` C ${s[1].x} ${s[1].y} ${s[2].x} ${s[2].y} ${s[3].x} ${s[3].y}`).join('') +
      ` L ${target.x} ${target.y}`;
    const collisions = points
      .slice(1, -1)
      .filter(p =>
        obstacles.some(
          r =>
            p.x > r.x + 0.5 &&
            p.x < r.x + r.width - 0.5 &&
            p.y > r.y + 0.5 &&
            p.y < r.y + r.height - 0.5,
        ),
      ).length;
    return {
      path,
      points,
      bend: bend ?? cubic(source, first, last, arrival, 0.5),
      midpoint,
      collisions,
    };
  }
  if (offset) return candidate({ x: midpoint.x + offset.x, y: midpoint.y + offset.y });
  // Only a pointer to its own exact spot needs a loop; otherwise a plain curve joins the rows.
  if (self && source.y === target.y)
    return candidate({ x: Math.max(source.x, target.x) + 100, y: midpoint.y - 60 });
  const direct = candidate(null);
  if (!direct.collisions) return direct;
  // Keep the obstacle-aware fallback for dense diagrams, with generous curves.
  const points = [...routePointer(source, arrival, targetSide, obstacles, 0, sourceSide), target];
  return {
    path: roundedPath(points, 24),
    points,
    bend: points[Math.floor(points.length / 2)],
    midpoint,
  };
}

/** Rounded corners stay within the routing gutter. */
function roundedPath(points, radius = 6) {
  if (!points?.length) return '';
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1],
      b = points[i],
      c = points[i + 1];
    const r = Math.min(radius, distance(a, b) / 2, distance(b, c) / 2);
    const before = { x: b.x + Math.sign(a.x - b.x) * r, y: b.y + Math.sign(a.y - b.y) * r };
    const after = { x: b.x + Math.sign(c.x - b.x) * r, y: b.y + Math.sign(c.y - b.y) * r };
    path += ` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`;
  }
  return path + ` L ${points.at(-1).x} ${points.at(-1).y}`;
}

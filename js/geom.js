// 平面几何。坐标单位 mm，y 轴向上。

export function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
export function subtract(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
export function scale(a, k) { return { x: a.x * k, y: a.y * k }; }
export function dot(a, b) { return a.x * b.x + a.y * b.y; }
export function length(a) { return Math.hypot(a.x, a.y); }

export function unitVector(a, b) {
  const d = subtract(b, a);
  const L = length(d) || 1;
  return { x: d.x / L, y: d.y / L };
}

export function normalVector(u) { return { x: -u.y, y: u.x }; }

// 矩形存 { a, b, angle }：a、b 是**未旋转**时的一对对角，shape 就是把那个框
// 绕自己的中心转 angle 度。angle 缺省 0，也就是全轴对齐。
export function rectAngleRad(rect) { return (rect.angle || 0) * Math.PI / 180; }

export function rectCenter(rect) {
  return { x: (rect.a.x + rect.b.x) / 2, y: (rect.a.y + rect.b.y) / 2 };
}

export function rectangleCorner(rect, index) {
  const x0 = Math.min(rect.a.x, rect.b.x), x1 = Math.max(rect.a.x, rect.b.x);
  const y0 = Math.min(rect.a.y, rect.b.y), y1 = Math.max(rect.a.y, rect.b.y);
  const c0 = rectCenter(rect);
  const t = rectAngleRad(rect), c = Math.cos(t), s = Math.sin(t);
  return [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
  ].map(({ x, y }) => {
    if (!rect.angle) return { x, y };
    const dx = x - c0.x, dy = y - c0.y;
    return { x: c0.x + dx * c - dy * s, y: c0.y + dx * s + dy * c };
  })[index];
}

export function rectangleCorners(rect) { return [0, 1, 2, 3].map(i => rectangleCorner(rect, i)); }

// 世界坐标 ↔ 矩形局部坐标（局部原点在中心，x 沿矩形自己的横轴）
export function toRectLocal(rect, p) {
  const c0 = rectCenter(rect);
  const t = rectAngleRad(rect), c = Math.cos(t), s = Math.sin(t);
  const dx = p.x - c0.x, dy = p.y - c0.y;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

export function fromRectLocal(rect, p) {
  const c0 = rectCenter(rect);
  const t = rectAngleRad(rect), c = Math.cos(t), s = Math.sin(t);
  return { x: c0.x + p.x * c - p.y * s, y: c0.y + p.x * s + p.y * c };
}

export function rectangleEdges(rect) {
  return [0, 1, 2, 3].map(i => ({
    a: rectangleCorner(rect, i),
    b: rectangleCorner(rect, (i + 1) % 4),
  }));
}

export function distanceToSegment(point, segment) {
  const v = subtract(segment.b, segment.a);
  const L2 = v.x * v.x + v.y * v.y;
  const t = L2 < 1e-12 ? 0
    : Math.max(0, Math.min(1, dot(subtract(point, segment.a), v) / L2));
  return length(subtract(point, add(segment.a, scale(v, t))));
}

// —— 区间工具 ——

function subtractIntervals(intervals, cut) {
  let result = intervals;
  for (const [c0, c1] of cut) {
    const next = [];
    for (const [a, b] of result) {
      if (c1 <= a || c0 >= b) { next.push([a, b]); continue; }
      if (a < c0) next.push([a, c0]);
      if (c1 < b) next.push([c1, b]);
    }
    result = next;
  }
  return result;
}

// 直线 P(t)=origin+u·t 上满足 |P(t)−w| < r 的 t 区间
function circleInterval(origin, u, w, r) {
  const rel = subtract(origin, w);
  const b = dot(u, rel);
  const c = dot(rel, rel) - r * r;
  const disc = b * b - c;
  if (disc <= 0) return null;
  const root = Math.sqrt(disc);
  return [-b - root, -b + root];
}

// 直线 P(t) 上到线段 seg 距离 < d 的 t 区间（三段：两端圆帽 + 线身带）
function capsuleIntervals(origin, u, seg, d) {
  const intervals = [];
  const capA = circleInterval(origin, u, seg.a, d);
  if (capA) intervals.push(capA);
  const capB = circleInterval(origin, u, seg.b, d);
  if (capB) intervals.push(capB);

  const v = unitVector(seg.a, seg.b);
  const nv = normalVector(v);
  const segLength = length(subtract(seg.b, seg.a));
  const rel = subtract(origin, seg.a);
  const slopePerp = dot(u, nv);
  const slopeAlong = dot(u, v);
  // 到无限直线的距离 < d
  let band = null;
  if (Math.abs(slopePerp) < 1e-12) {
    if (Math.abs(dot(rel, nv)) < d) band = [-Infinity, Infinity];
  } else {
    const mid = -dot(rel, nv) / slopePerp;
    const half = d / Math.abs(slopePerp);
    band = [mid - half, mid + half];
  }
  // 垂足落在 [0, segLength] 内
  let foot = null;
  if (Math.abs(slopeAlong) < 1e-12) {
    const p = dot(rel, v);
    if (p >= 0 && p <= segLength) foot = [-Infinity, Infinity];
  } else {
    const t0 = (0 - dot(rel, v)) / slopeAlong;
    const t1 = (segLength - dot(rel, v)) / slopeAlong;
    foot = [Math.min(t0, t1), Math.max(t0, t1)];
  }
  if (band && foot) {
    const a = Math.max(band[0], foot[0]);
    const b = Math.min(band[1], foot[1]);
    if (a < b) intervals.push([a, b]);
  }
  return intervals;
}

// 刀具半径 d 的刀路：到最近黑线距离恰为 d 的点集，返回线段数组（圆弧采样成折线）。
// 三部分：① 每段两侧的偏移线；② 顶点的圆弧 —— 外角是 R=d 的圆角、自由端是半圆帽。
// 有了②，红线才是闭合的：偏移线在切点收住，圆弧把两个切点连起来。
export function roundedOffset(segments, d) {
  const result = [];

  // ① 偏移线：剪掉离别的黑线不足 d 的部分
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const u = unitVector(s.a, s.b);
    const segLength = length(subtract(s.b, s.a));
    if (segLength < 1e-9) continue;
    for (const side of [1, -1]) {
      const origin = add(s.a, scale(normalVector(u), d * side));
      let intervals = [[0, segLength]];
      for (let j = 0; j < segments.length; j++) {
        if (j === i) continue;
        intervals = subtractIntervals(intervals, capsuleIntervals(origin, u, segments[j], d));
        if (!intervals.length) break;
      }
      for (const [t0, t1] of intervals) {
        if (t1 - t0 < 1e-6) continue;
        result.push({ a: add(origin, scale(u, t0)), b: add(origin, scale(u, t1)) });
      }
    }
  }

  // ② 顶点圆弧。存的是「从该端点指向段内」的方向，判据要用它。
  const vertices = new Map();
  for (const s of segments) {
    const u = unitVector(s.a, s.b);
    collectVertex(vertices, s.a, u);
    collectVertex(vertices, s.b, { x: -u.x, y: -u.y });
  }
  for (const vertex of vertices.values()) {
    const { point, directions } = vertex;
    // 圆弧被别的黑线吃掉的部分，按**角度区间**精确扣掉。
    // 不能按采样点一个个判：采样点被吞掉一个，圆弧就在那里断成两截，
    // 断口正好是一个弦长（d = 1 时 ≈ 0.13 mm），放大看得见。
    // 区间是解析解，边界落在相切点上，跟偏移线的端点严丝合缝。
    let spans = outerArcSpans(point, directions);
    for (const s of segments) {
      // 只跳过「端点就是这个顶点」的段：圆弧在它们的外侧，本来就不该被它们剪。
      // 判据不能用「顶点在这条段上」——T 形接头那里顶点落在另一条段的中间，
      // 那条段恰恰应该把圆弧整条吞掉。
      if (isIncident(point, s)) continue;
      spans = subtractIntervals(spans, swallowedSpans(point, d, s));
      if (!spans.length) break;
    }
    for (const [start, end] of spans) {
      const steps = Math.max(1, Math.ceil((end - start) / ARC_STEP));
      const run = [];
      for (let k = 0; k <= steps; k++) {
        const phi = start + (end - start) * k / steps;
        run.push({ x: point.x + d * Math.cos(phi), y: point.y + d * Math.sin(phi) });
      }
      emitPolyline(result, run);
    }
  }
  return result;
}

const TWO_PI = 2 * Math.PI;
const ARC_STEP = Math.PI / 48;   // 圆弧折线步长：d = 1 mm 时弦高 0.5 µm

// 圆心 V、半径 d 的圆上，落进 seg 的胶囊内部（到 seg 距离 < d）的 φ 区间，解析解。
// 胶囊 = 两端各一个 d 圆盘 ∪（到无限直线距离 < d 且垂足落在段内）。
// 两个圆盘、直线带各给一个 cos 不等式，再跟垂足带求交。
// 区间按 ±2π 铺开，好跟任意绕圈的圆弧区间相减。
function swallowedSpans(V, d, seg) {
  const v = unitVector(seg.a, seg.b);
  const nv = normalVector(v);
  const segLength = length(subtract(seg.b, seg.a));
  const w = subtract(V, seg.a);
  const out = [];

  for (const corner of [seg.a, seg.b]) {
    const rel = subtract(V, corner);
    const rho = length(rel);
    if (rho < 1e-12) continue;          // 圆心正落在这个端点上，圆到它处处等于 d，进不去
    if (rho > 2 * d) continue;          // 两个圆不相交
    // |w + d·e(φ)| < d  ⟺  cos(φ − ψ) < −ρ/(2d)
    out.push(...spread(cosLess(-rho / (2 * d)), Math.atan2(rel.y, rel.x)));
  }

  // 到无限直线的距离 < d：|g + d·cos(φ − ν)| < d
  const g = dot(w, nv);
  const band = spread(cosBetween(-1 - g / d, 1 - g / d), Math.atan2(nv.y, nv.x));
  // 垂足落在 [0, L]：(w + d·e)·v ∈ [0, L]
  const h = dot(w, v);
  const slab = spread(cosBetween(-h / d, (segLength - h) / d), Math.atan2(v.y, v.x));
  // 两边都要先铺开再求交：整圆写成 [0, 2π] 换个相位就是 [ν, ν+2π]，
  // 直接跟另一个整圆求交会被裁成半圈，圆弧就凭空留下半截。
  out.push(...intersectLists(band, slab));
  return out;
}

// {cos u < k}
function cosLess(k) {
  if (k <= -1) return [];            // cos 不可能小于 −1
  if (k >= 1) return [[0, TWO_PI]];
  const b = Math.acos(k);
  return [[b, TWO_PI - b]];
}

// {k0 ≤ cos u ≤ k1}
function cosBetween(k0, k1) {
  const lower = k0 <= -1 ? [[0, TWO_PI]]
    : k0 >= 1 ? []
    : [[0, Math.acos(k0)], [TWO_PI - Math.acos(k0), TWO_PI]];
  const upper = k1 >= 1 ? [[0, TWO_PI]]
    : k1 <= -1 ? []
    : [[Math.acos(k1), TWO_PI - Math.acos(k1)]];
  return intersectLists(lower, upper);
}

function intersectLists(a, b) {
  const out = [];
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      const s = Math.max(a0, b0), e = Math.min(a1, b1);
      if (e > s) out.push([s, e]);
    }
  }
  return out;
}

function spread(spans, base) {
  const out = [];
  for (const [s, e] of spans) {
    for (const k of [-2 * TWO_PI, -TWO_PI, 0, TWO_PI, 2 * TWO_PI]) {
      out.push([s + base + k, e + base + k]);
    }
  }
  return out;
}

// 顶点是不是这条线段的端点（坐标是原样复制的，可以直接比）
function isIncident(p, s) {
  return (s.a.x === p.x && s.a.y === p.y) || (s.b.x === p.x && s.b.y === p.y);
}

function collectVertex(map, point, direction) {
  const k = `${point.x.toFixed(6)},${point.y.toFixed(6)}`;
  if (!map.has(k)) map.set(k, { point: { x: point.x, y: point.y }, directions: [] });
  map.get(k).directions.push(direction);
}

function emitPolyline(result, points) {
  for (let i = 1; i < points.length; i++) {
    if (length(subtract(points[i], points[i - 1])) < 1e-6) continue;
    result.push({ a: points[i - 1], b: points[i] });
  }
}

// 顶点处该画的圆弧角度区间：半径 d、圆心是该顶点，条件是它对每条相邻线段都有
// 垂足落在端点之外（即 cos·u ≤ 0）。边界恰在 θ±90°，那里的点正好是切点，
// 和偏移线的端点严丝合缝，所以红线是闭合的。用采样求边界会差 0.25°，接不上。
function outerArcSpans(point, directions) {
  if (!directions.length) return [];
  const twoPi = 2 * Math.PI;
  const cuts = [];
  for (const u of directions) {
    const theta = Math.atan2(u.y, u.x);
    for (const offset of [Math.PI / 2, 3 * Math.PI / 2]) {
      let a = (theta + offset) % twoPi;
      if (a < 0) a += twoPi;
      cuts.push(a);
    }
  }
  cuts.sort((a, b) => a - b);

  const valid = phi => directions.every(u => Math.cos(phi) * u.x + Math.sin(phi) * u.y <= 0);
  const spans = [];
  for (let i = 0; i < cuts.length; i++) {
    const start = cuts[i];
    const end = i + 1 < cuts.length ? cuts[i + 1] : cuts[0] + twoPi;
    if (end - start < 1e-12) continue;
    if (!valid((start + end) / 2)) continue;
    const last = spans[spans.length - 1];
    if (last && Math.abs(last[1] - start) < 1e-12) last[1] = end;
    else spans.push([start, end]);
  }
  // 首尾在 2π 处相接的合成一段
  if (spans.length > 1
      && Math.abs(spans[0][0] - cuts[0]) < 1e-12
      && Math.abs(spans[spans.length - 1][1] - (cuts[0] + twoPi)) < 1e-12) {
    spans[0][0] = spans[spans.length - 1][0] - twoPi;
    spans.pop();
  }
  void point;
  return spans;
}

// 吸附。优先级：端点 → 网格 → 相对起点的正交。
// 网格是主力：1mm 一格，鼠标离格线不超过 tolerance 就归到格线上，x、y 各自判断。
export function snapPoint(point, {
  points = [], from = null, tolerance = 0, grid = 0, gridTolerance = tolerance,
  orthoDeg = 4, enabled = true,
}) {
  if (!enabled) return { point, snapped: false, kind: null };

  let nearest = null;
  let best = tolerance;
  for (const p of points) {
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d < best) { best = d; nearest = p; }
  }
  if (nearest) return { point: { x: nearest.x, y: nearest.y }, snapped: true, kind: 'endpoint' };

  const result = { x: point.x, y: point.y };
  let snapped = false;
  let kind = null;

  if (grid > 0) {
    const gx = Math.round(point.x / grid) * grid;
    const gy = Math.round(point.y / grid) * grid;
    if (Math.abs(gx - point.x) <= gridTolerance) { result.x = gx; snapped = true; kind = 'grid'; }
    if (Math.abs(gy - point.y) <= gridTolerance) { result.y = gy; snapped = true; kind = 'grid'; }
  }

  if (from) {
    const dx = result.x - from.x, dy = result.y - from.y;
    if (Math.hypot(dx, dy) > 1e-6) {
      const angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
      // 光看角度不行：100 mm 外偏 4° 就是 7 mm，鼠标被硬拽走一大截。
      // 角度在阈值内**而且**垂直偏移不超过 tolerance 才拉平/拉直。
      if ((angle < orthoDeg || angle > 180 - orthoDeg) && Math.abs(dy) <= tolerance) {
        result.y = from.y; snapped = true; kind = kind || 'ortho';
      } else if (Math.abs(angle - 90) < orthoDeg && Math.abs(dx) <= tolerance) {
        result.x = from.x; snapped = true; kind = kind || 'ortho';
      }
    }
  }
  return { point: result, snapped, kind };
}

// —— 销孔预设 ——
// 局部坐标：原点 = 两个主销孔的中点；x 沿「横排」方向，y 向上；长圆孔长轴沿局部 y。
// 孔尺寸全场统一：2.65 × 5.9。
// 4 孔是完全体，其余三个是「去掉某一个孔」的变体。
// 每个孔写 [x, y, 自身转角]：0 = 长轴沿局部 y（竖），90 = 长轴沿局部 x（横）。
// 注意下挂那个孔在图上**是横的**，跟横排上的竖孔垂直。
export const SLOT_W = 2.5, SLOT_L = 4.7;   // 所有销孔统一这个尺寸

export const PIN_PRESETS = {
  p4:  { name: '4孔',      holes: [[-4, 0, 0], [0, 0, 0], [4, 0, 0], [0, -6.7, 90]] },
  p3h: { name: '3孔·横排', holes: [[-4, 0, 0], [0, 0, 0], [4, 0, 0]] },
  p3v: { name: '3孔·下挂', holes: [[-4, 0, 0], [4, 0, 0], [0, -6.7, 90]] },
  p2:  { name: '2孔',      holes: [[-4, 0, 0], [4, 0, 0]] },
};

// 把预设摆到世界坐标：center 是原点落点，angleDeg 是整体转向。
// flipped 是「这份是镜像出来的」：关于水平轴反射后，组件本地 y 会翻向，
// 下挂孔得挪到另一侧，孔自身的转角也跟着反向。整份尺寸不变。
export function pinHoles(kind, center, angleDeg, flipped = false) {
  const t = angleDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return PIN_PRESETS[kind].holes.map(([x, y, own = 0]) => {
    const ly = flipped ? -y : y;
    return {
      center: { x: center.x + x * c - ly * s, y: center.y + x * s + ly * c },
      angle: angleDeg + (flipped ? -own : own),   // 孔自身的转角叠在组件转角上
    };
  });
}

// —— 掏角矩形 ——
// 把矩形的四个 90° 顶角换成 r = relief 的 180° 圆弧。
// 圆心：角点沿对角线往内、每轴偏 relief/√2 —— 也就是离角点恰好 relief，
//       于是半径取 relief 时圆正好过角点；两个切点落在两条边上、离角点 relief·√2，
//       而这两点到圆心的距离也是 relief，所以它们也恰在圆上。
// 半圆两端（切点）关于圆心对径，两条边在切点处收住，由这段半圆接起来。
// 与 dxf/figure.html 的 filletRect 同一套推导。
export const RELIEF = 0.07;

// center 是中心，angleRad 是整体转角，hx/hy 是半宽半高 —— 销孔是斜的，所以带转角。
export function reliefRect(center, angleRad, hx, hy, d = RELIEF) {
  const co = Math.cos(angleRad), si = Math.sin(angleRad);
  const G = (lx, ly) => ({ x: center.x + lx * co - ly * si, y: center.y + lx * si + ly * co });
  const sp = d / Math.SQRT2;     // 圆心每轴内偏
  const tp = d * Math.SQRT2;     // 切点离角点
  if (hx <= tp || hy <= tp) {    // 太小了摆不下，退回普通矩形
    const k = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([x, y]) => G(x, y));
    return { lines: [0, 1, 2, 3].map(i => ({ a: k[i], b: k[(i + 1) % 4] })), arcs: [] };
  }
  const lines = [
    [G(-hx + tp, -hy), G(hx - tp, -hy)],
    [G(hx, -hy + tp), G(hx, hy - tp)],
    [G(hx - tp, hy), G(-hx + tp, hy)],
    [G(-hx, hy - tp), G(-hx, -hy + tp)],
  ].map(([a, b]) => ({ a, b }));
  const arcs = [];
  for (const [sx, sy] of [[1, -1], [1, 1], [-1, 1], [-1, -1]]) {
    const C = G(sx * (hx - sp), sy * (hy - sp));
    const A = G(sx * hx, sy * (hy - tp));     // 竖边上的切点
    const B = G(sx * (hx - tp), sy * hy);     // 横边上的切点
    const corner = G(sx * hx, sy * hy);
    const aA = Math.atan2(A.y - C.y, A.x - C.x);
    const aC = Math.atan2(corner.y - C.y, corner.x - C.x);
    const turn = ((aC - aA) % TWO_PI + TWO_PI) % TWO_PI;
    const a0 = turn < Math.PI ? aA : aA - Math.PI;   // 取经过角点的那半圆
    arcs.push({ c: C, a0, a1: a0 + Math.PI, r: d });
  }
  return { lines, arcs };
}

export function reliefRectPath(rect) {
  const x0 = Math.min(rect.a.x, rect.b.x), x1 = Math.max(rect.a.x, rect.b.x);
  const y0 = Math.min(rect.a.y, rect.b.y), y1 = Math.max(rect.a.y, rect.b.y);
  return reliefRect({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, rectAngleRad(rect),
                    (x1 - x0) / 2, (y1 - y0) / 2, rect.relief ?? RELIEF);
}

// 连接头（销孔组件）里的每个长圆孔：一律掏过角的成品孔
export function slotPath(center, angleDeg) {
  return reliefRect(center, angleDeg * Math.PI / 180, SLOT_W / 2, SLOT_L / 2, RELIEF);
}

// —— 上下对称 ——
// 关于水平线 y = y0 镜像。点的 y 翻到 2*y0−y；销孔元件还要把转角反向。
export function mirrorPoint(p, y0) { return { x: p.x, y: 2 * y0 - p.y }; }

export function mirrorEntity(entity, y0) {
  if (entity.type === 'pins') {
    // 反射 = 中心的镜像 + 转角取反 + 本地 y 翻向（pinHoles 的 flipped）
    return { ...entity, id: `${entity.id}-sym`, derived: true, mirrored: true,
             center: mirrorPoint(entity.center, y0), angle: -entity.angle };
  }
  return { ...entity, id: `${entity.id}-sym`, derived: true,
           a: mirrorPoint(entity.a, y0), b: mirrorPoint(entity.b, y0) };
}

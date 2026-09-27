import * as geom from './geom.js?v=25';
import * as store from './store.js?v=25';

const WIDTH = 195;        // 画布尺寸 mm
const HEIGHT = 95;
const KERF = 1;           // 刀缝半径 mm：黑线两侧各 KERF 处生成红线
const GRID_MINOR = 1;     // 小格 mm
const GRID_MAJOR = 10;    // 大格 mm
const SNAP_PIXELS = 6;    // 端点吸附半径，屏幕像素
const ORTHO_DEGREES = 4;    // 正交吸附角度阈值
const PIN_ANGLE_STEP = 5;   // 放置销孔时方向吸附到 5°
const ZOOM_MIN_WIDTH = 5;    // 视图最窄 mm，再近就没意义
const ZOOM_MAX_WIDTH = 2000; // 视图最宽 mm，防止一路缩放乘飞

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('board');
const tip = document.getElementById('tip');
const slotSelect = document.getElementById('slots');

function createLayer() {
  const g = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(g);
  return g;
}
const gridLayer = createLayer();
const redLayer = createLayer();
const blackLayer = createLayer();
const pointLayer = createLayer();
const handleLayer = createLayer();
const previewLayer = createLayer();
const hoverLayer = createLayer();

let data = store.loadData();
let view = currentSlot().view || fitView();
let entities = currentSlot().entities;
let tool = 'black';
let selected = new Set();          // 选中的整个图元（销孔、或点中的线）
let selectedVertices = new Set();  // 选中的顶点，键是 `${entityId}:${key}`
let band = null;                   // 正在拉的框选橡皮筋 { start, end }
let history = [];
let future = [];
let snapEnabled = true;
let gridEnabled = true;
let symEnabled = currentSlot().sym === true;   // 上下对称：轴上下一模一样
let dragging = null;
let panning = null;
let placing = null;     // 正在放置的销孔组件 { kind, center, angle }
let placingKind = null;
let hovering = null;
let hoverKey = null;
let pinch = null;
let nextId = 1;

const activePointers = new Map();   // pointerId → 事件，用来分辨单指画线 / 双指缩放

function currentSlot() { return data.slots[data.current]; }
function nowSlot() { return data.slots[data.current]; }

function fitView() { return { x: -6, y: -6, width: WIDTH + 12, height: HEIGHT + 12 }; }

// —— 选中矩形后的属性输入框 ——
// 面板是常驻的 DOM，只改 value 和 hidden：每帧重建的话输入焦点会被打断，打字打一半就没了。
const propInputs = {
  w: document.getElementById('p-w'), h: document.getElementById('p-h'),
  x: document.getElementById('p-x'), y: document.getElementById('p-y'),
  a: document.getElementById('p-a'),
};
let propsBefore = null;   // 一次编辑开始前的快照，改完整体记一步撤销

function selectedRect() {
  if (selected.size !== 1) return null;
  const entity = entities.find(e => selected.has(e.id));
  return entity && entity.type === 'rect' ? entity : null;
}

function setProps() {
  const box = document.getElementById('props');
  const rect = selectedRect();
  if (!box) return;
  box.hidden = !rect;
  if (!rect) return;
  const c = geom.rectCenter(rect);
  const values = {
    w: Math.abs(rect.b.x - rect.a.x), h: Math.abs(rect.b.y - rect.a.y),
    x: c.x, y: c.y, a: rect.angle || 0,
  };
  for (const name in values) {
    const el = propInputs[name];
    if (document.activeElement !== el) el.value = Math.round(values[name] * 1000) / 1000;
  }
}

function applyProps() {
  const rect = selectedRect();
  if (!rect) return;
  const c = geom.rectCenter(rect);
  const num = (el, fallback) => {
    const v = Number(el.value);
    return Number.isFinite(v) ? v : fallback;
  };
  const w = Math.max(0.01, num(propInputs.w, Math.abs(rect.b.x - rect.a.x)));
  const h = Math.max(0.01, num(propInputs.h, Math.abs(rect.b.y - rect.a.y)));
  const cx = num(propInputs.x, c.x), cy = num(propInputs.y, c.y);
  const angle = num(propInputs.a, rect.angle || 0);
  rect.a = { x: cx - w / 2, y: cy - h / 2 };
  rect.b = { x: cx + w / 2, y: cy + h / 2 };
  if (angle) rect.angle = angle; else delete rect.angle;
  persist();
  render();
}

for (const el of Object.values(propInputs)) {
  el.addEventListener('focus', () => { propsBefore = JSON.stringify(entities); });
  el.addEventListener('input', applyProps);
  el.addEventListener('change', () => {
    if (propsBefore && JSON.stringify(entities) !== propsBefore) rememberValue(propsBefore);
    propsBefore = null;
  });
}

const SYM_Y = HEIGHT / 2;    // 对称轴默认落在画布中线
const isSymAxis = e => e.type === 'segment' && e.sym === true;
// 镜面高度取轴自己的 y：拖着轴上下挪，镜像跟着挪
const symAxisY = () => (entities.find(isSymAxis) || { a: { y: SYM_Y } }).a.y;

// 定哪条是镜面。对称轴就是一个普通黑实体：照吃刀、能选能拖、一直在图上，
// sym 标记只说「这条是镜面」。勾选框只决定镜不镜像，管不着它的存在。
// 图上已经有横贯画布的黑线段（自己画的轴），就直接标它，别再造一条假的出来；
// 有多条就挑离画布中线最近的那条；一条都没有才新画。
function ensureSymAxis() {
  if (entities.some(isSymAxis)) return;
  const spanning = entities.filter(e => e.type === 'segment' && e.color === 'black'
    && Math.abs(e.a.y - e.b.y) < 1e-9 && Math.abs(e.b.x - e.a.x) >= WIDTH - 1e-9);
  if (spanning.length) {
    const axis = spanning.reduce((best, e) =>
      Math.abs(e.a.y - SYM_Y) < Math.abs(best.a.y - SYM_Y) ? e : best);
    axis.sym = true;
    return;
  }
  entities.push({ id: `s${nextId++}`, type: 'segment', color: 'black', sym: true,
                  a: { x: 0, y: SYM_Y }, b: { x: WIDTH, y: SYM_Y } });
}

function syncSymBox() {
  const box = document.getElementById('sym');
  if (box) box.checked = symEnabled;
}

// 图上实际要画的东西：存档里的原始图元，开对称时再跟一份关于轴的镜像。
// 镜像和派生红线一样是现算的，存档里没有它，导出/导入都碰不到它。
// alpha 只影响怎么画，不影响几何——黑线镜像那份淡一点，一眼分得出哪份是抄的。
function displayEntities() {
  if (!symEnabled) return entities.map(entity => ({ entity, alpha: 1 }));
  return [
    ...entities.map(entity => ({ entity, alpha: 1 })),
    ...entities.filter(entity => !isSymAxis(entity))
               .map(entity => ({ entity: geom.mirrorEntity(entity, symAxisY()), alpha: 0.45 })),
  ];
}

// 一组销孔实际摆在哪。镜像那份要按反射算，交给 geom.pinHoles 的 flipped 处理，
// 别处一律走这里，免得漏掉翻向。
function pinHolesOf(entity) {
  return geom.pinHoles(entity.kind, entity.center, entity.angle, entity.mirrored === true);
}

// 销孔落点：开吸附才归到整毫米，关掉就落在鼠标原处
function snapPinCenter(point, event) {
  const p = clampToCanvas(point);
  if (!snapEnabled || event.altKey) return p;
  const tol = gridSnapTolerance();
  const gx = Math.round(p.x / GRID_MINOR) * GRID_MINOR;
  const gy = Math.round(p.y / GRID_MINOR) * GRID_MINOR;
  return {
    x: Math.abs(gx - p.x) <= tol ? gx : p.x,
    y: Math.abs(gy - p.y) <= tol ? gy : p.y,
  };
}

// 销孔转角：吸附开着才吸到 5°，关掉就是鼠标给多少是多少 —— 方向键/方括号再微调
function pinAngle(raw, event) {
  return snapEnabled && !event.altKey
    ? Math.round(raw / PIN_ANGLE_STEP) * PIN_ANGLE_STEP
    : raw;
}

// 模型坐标 y 向上，SVG y 向下，这里换一下
function toSvgX(x) { return x; }
function toSvgY(y) { return HEIGHT - y; }

function createSvg(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const name in attributes) node.setAttribute(name, attributes[name]);
  return node;
}

function updateViewBox() {
  svg.setAttribute('viewBox', `${view.x} ${HEIGHT - view.y - view.height} ${view.width} ${view.height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
}

// 屏幕像素 / 模型单位。取宽高两个方向的小值，跟 preserveAspectRatio 一致。
function pixelsPerMm() {
  const box = svg.getBoundingClientRect();
  return Math.min(box.width / view.width, box.height / view.height);
}

function snapTolerance() {
  return SNAP_PIXELS / pixelsPerMm();
}

// 网格吸附半径：半格以内归到最近的格线。取 min 是为了放大到一格几十像素时，
// 仍然稳稳落在整毫米上，而不是要精确到零点几毫米才吸得住。
function gridSnapTolerance() {
  return Math.min(snapTolerance(), GRID_MINOR / 2);
}

// 以 center 为中心把 base 视图缩放 factor 倍，并把宽度卡在上下限内。
// base 传副本：捏合要按手指落下那一刻的视图算，不能按已经被改过的 view 累乘。
function zoomAt(base, center, factor) {
  const width = Math.min(Math.max(base.width / factor, ZOOM_MIN_WIDTH), ZOOM_MAX_WIDTH);
  const k = base.width / width;
  view.width = width;
  view.height = base.height / k;
  view.x = center.x - (center.x - base.x) / k;
  view.y = center.y - (center.y - base.y) / k;
}

// 画到画布外的点一律压回边界
function clampToCanvas(p) {
  return {
    x: Math.min(Math.max(p.x, 0), WIDTH),
    y: Math.min(Math.max(p.y, 0), HEIGHT),
  };
}

// 所有端点，供吸附用。excludeId 用来排除正在被拖的那个图元——
// 不排除的话，拖自己的顶点会被自己的旧位置吸住，纹丝不动。
function allEndpoints(excludeId = null) {
  const points = [];
  for (const entity of entities) {
    if (entity.id === excludeId) continue;
    if (entity.type === 'segment') {
      points.push(entity.a, entity.b);
    } else if (entity.type === 'pins') {
      for (const h of pinHolesOf(entity)) points.push(h.center);
      points.push(entity.center);
    } else {
      for (let i = 0; i < 4; i++) points.push(geom.rectangleCorner(entity, i));
    }
  }
  return points;
}

// 全部黑线（矩形拆成四条边），红线在这些线的距离场上求。
// 走的是 displayEntities：开了对称，镜像那份黑线也算进来，刀路自然跟着对称过去，
// 不用另写一套镜像红线的代码。对称轴在这里就是一条普通黑线，一视同仁。
function blackSegments() {
  const segments = [];
  for (const { entity } of displayEntities()) {
    if (entity.color !== 'black') continue;
    if (entity.type === 'segment') segments.push({ a: entity.a, b: entity.b });
    else segments.push(...geom.rectangleEdges(entity));
  }
  return segments;
}

// 派生红线：到最近黑线距离恰好 KERF。不进存档，每次渲染重算。
function derivedEntities() {
  return geom.roundedOffset(blackSegments(), KERF).map(s => ({
    id: `derived-${nextId++}`, type: 'segment', color: 'red', derived: true, a: s.a, b: s.b,
  }));
}

function drawGrid() {
  gridLayer.replaceChildren();
  if (!gridEnabled) return;
  // stroke 和 stroke-width 能继承，vector-effect 不行：写在组上会被当成用户单位
  // （≈5 像素），所以每条线自己带一份，粗细才是屏幕像素
  const style = { 'shape-rendering': 'crispEdges', 'vector-effect': 'non-scaling-stroke' };
  const minor = createSvg('g', { stroke: '#dae0e6', 'stroke-width': 1 });
  const major = createSvg('g', { stroke: '#89939f', 'stroke-width': 1.6 });
  for (let x = 0; x <= WIDTH; x += GRID_MINOR) {
    const line = createSvg('line', { x1: x, y1: 0, x2: x, y2: HEIGHT, ...style });
    (Math.abs(x % GRID_MAJOR) < 1e-9 ? major : minor).appendChild(line);
  }
  for (let y = 0; y <= HEIGHT; y += GRID_MINOR) {
    const line = createSvg('line', { x1: 0, y1: toSvgY(y), x2: WIDTH, y2: toSvgY(y), ...style });
    (Math.abs(y % GRID_MAJOR) < 1e-9 ? major : minor).appendChild(line);
  }
  gridLayer.appendChild(minor);
  gridLayer.appendChild(major);
  gridLayer.appendChild(createSvg('rect', {
    x: 0, y: 0, width: WIDTH, height: HEIGHT,
    fill: 'none', stroke: '#59626e', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke',
  }));
}

function entityAttributes(entity) {
  const isRed = entity.color === 'red';
  return {
    // 层级（屏幕像素，non-scaling）：小格 1 < 大格 1.6 < 边框 2 < 红线 1.2（细但红）
    // < 黑线 2.4 < 选中 3.4。黑线必须压过所有格线，否则整个图看起来是虚的。
    stroke: isRed ? '#d93025' : '#1a1a1a',
    'stroke-width': selected.has(entity.id) ? 3.4 : (isRed ? 1.2 : 2.4),
    fill: 'none',
    'vector-effect': 'non-scaling-stroke',
  };
}

// 掏角轮廓：四条边（切点之间）+ 四个 180° 半圆。
// SVG 的 y 朝下，模型的逆时针到这里是逆时针的**反**，所以 sweep-flag 取 0。
function pathData({ lines, arcs }) {
  let d = '';
  for (const arc of arcs) {
    const p0 = { x: arc.c.x + arc.r * Math.cos(arc.a0), y: arc.c.y + arc.r * Math.sin(arc.a0) };
    const p1 = { x: arc.c.x + arc.r * Math.cos(arc.a1), y: arc.c.y + arc.r * Math.sin(arc.a1) };
    d += `M ${toSvgX(p0.x)} ${toSvgY(p0.y)} A ${arc.r} ${arc.r} 0 0 0 ${toSvgX(p1.x)} ${toSvgY(p1.y)} `;
  }
  for (const l of lines) {
    d += `M ${toSvgX(l.a.x)} ${toSvgY(l.a.y)} L ${toSvgX(l.b.x)} ${toSvgY(l.b.y)} `;
  }
  return d;
}

const reliefPathData = entity => pathData(geom.reliefRectPath(entity));

function drawEntity(layer, entity, alpha = 1) {
  const attributes = entityAttributes(entity);
  if (alpha < 1) attributes.opacity = alpha;
  if (entity.type === 'segment') {
    layer.appendChild(createSvg('line', {
      x1: toSvgX(entity.a.x), y1: toSvgY(entity.a.y),
      x2: toSvgX(entity.b.x), y2: toSvgY(entity.b.y), ...attributes,
    }));
  } else if (entity.relief) {
    layer.appendChild(createSvg('path', { d: reliefPathData(entity), ...attributes }));
  } else if (entity.angle) {
    const pts = geom.rectangleCorners(entity);
    layer.appendChild(createSvg('polygon', {
      points: pts.map(p => `${toSvgX(p.x)},${toSvgY(p.y)}`).join(' '), ...attributes,
    }));
  } else {
    const x = Math.min(entity.a.x, entity.b.x);
    const y = Math.min(entity.a.y, entity.b.y);
    layer.appendChild(createSvg('rect', {
      x, y: toSvgY(y + Math.abs(entity.b.y - entity.a.y)),
      width: Math.abs(entity.b.x - entity.a.x), height: Math.abs(entity.b.y - entity.a.y),
      ...attributes,
    }));
  }
}

// 销孔组件（连接头）：按预设摆出一组长圆孔，每个孔都是掏过角的
function drawPins(entity, alpha = 1) {
  const attributes = entityAttributes(entity);
  if (alpha < 1) attributes.opacity = alpha;
  for (const h of pinHolesOf(entity)) {
    redLayer.appendChild(createSvg('path', {
      d: pathData(geom.slotPath(h.center, h.angle)), ...attributes,
    }));
  }
}

// 销孔组件的「转向把手」：本地 (+4,0) 那个位置
function pinHandle(entity) {
  const t = entity.angle * Math.PI / 180;
  return { x: entity.center.x + 4 * Math.cos(t), y: entity.center.y + 4 * Math.sin(t) };
}

// 矩形的「转向把手」：从中心沿矩形自己的横轴往外挪一格多点，拖它转
function rectHandle(entity) {
  const center = geom.rectCenter(entity);
  const reach = Math.abs(entity.b.x - entity.a.x) / 2 + 10 / pixelsPerMm();
  const t = geom.rectAngleRad(entity);
  return { x: center.x + reach * Math.cos(t), y: center.y + reach * Math.sin(t) };
}

function rectHandleHit(point) {
  if (tool !== 'pick') return null;
  const reach = 9 / pixelsPerMm();
  for (const entity of entities) {
    if (entity.type !== 'rect' || !selected.has(entity.id)) continue;
    if (Math.hypot(rectHandle(entity).x - point.x, rectHandle(entity).y - point.y) <= reach) {
      return entity;
    }
  }
  return null;
}

function drawPreview() {
  previewLayer.replaceChildren();
  if (!dragging || !dragging.shape) return;   // 拖顶点没有待画的形状
  const shape = dragging.shape;
  const attributes = {
    stroke: '#1a73e8', 'stroke-width': 1.2, 'stroke-dasharray': '4 3',
    fill: 'none', 'vector-effect': 'non-scaling-stroke',
  };
  // 只有吸到端点才画圈：网格吸附有格线本身作参照，再套个圈纯属添乱
  if (dragging.kind === 'endpoint') {
    previewLayer.appendChild(createSvg('circle', {
      cx: toSvgX(shape.b.x), cy: toSvgY(shape.b.y), r: 3 / pixelsPerMm(),
      fill: 'none', stroke: '#e8890c', 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke',
    }));
  }
  if (shape.type === 'segment') {
    previewLayer.appendChild(createSvg('line', {
      x1: toSvgX(shape.a.x), y1: toSvgY(shape.a.y),
      x2: toSvgX(shape.b.x), y2: toSvgY(shape.b.y), ...attributes,
    }));
  } else if (shape.relief) {
    previewLayer.appendChild(createSvg('path', { d: reliefPathData(shape), ...attributes }));
  } else {
    const x = Math.min(shape.a.x, shape.b.x);
    const y = Math.min(shape.a.y, shape.b.y);
    previewLayer.appendChild(createSvg('rect', {
      x, y: toSvgY(y + Math.abs(shape.b.y - shape.a.y)),
      width: Math.abs(shape.b.x - shape.a.x), height: Math.abs(shape.b.y - shape.a.y), ...attributes,
    }));
  }
}

// 框选用的橡皮筋
function drawBand() {
  if (!band) return;
  const x0 = Math.min(band.start.x, band.end.x), x1 = Math.max(band.start.x, band.end.x);
  const y0 = Math.min(band.start.y, band.end.y), y1 = Math.max(band.start.y, band.end.y);
  previewLayer.appendChild(createSvg('rect', {
    x: x0, y: toSvgY(y1), width: x1 - x0, height: y1 - y0,
    fill: '#1a73e8', 'fill-opacity': 0.08, stroke: '#1a73e8', 'stroke-width': 1,
    'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke',
    'shape-rendering': 'crispEdges',
  }));
}

// 端点用小圆点画出来，半径固定 2.5 屏幕像素
function drawPoints() {
  pointLayer.replaceChildren();
  const radius = 2.5 / pixelsPerMm();
  for (const entity of entities) {
    const points = entity.type === 'segment' ? [entity.a, entity.b]
      : entity.type === 'pins' ? pinHolesOf(entity).map(h => h.center)
      : [0, 1, 2, 3].map(i => geom.rectangleCorner(entity, i));
    for (const p of points) {
      pointLayer.appendChild(createSvg('circle', {
        cx: toSvgX(p.x), cy: toSvgY(p.y), r: radius, fill: '#1a1a1a',
      }));
    }
  }
}

// 图元的可拖顶点：线段是两端，矩形是四个角
function vertexHandles(entity) {
  if (entity.type === 'segment') return [{ key: 'a', point: entity.a }, { key: 'b', point: entity.b }];
  if (entity.type === 'pins') return [];                 // 销孔不走顶点拖动，另走把手
  return [0, 1, 2, 3].map(i => ({ key: i, point: geom.rectangleCorner(entity, i) }));
}

// 能进框选的顶点：黑线的两端、矩形的四角。销孔、红线不参与。
function selectableVertices() {
  const out = [];
  for (const entity of entities) {
    if (entity.type === 'segment') {
      if (entity.color === 'black') out.push({ entity, key: 'a' }, { entity, key: 'b' });
    } else if (entity.type !== 'pins') {
      for (let i = 0; i < 4; i++) out.push({ entity, key: i });
    }
  }
  return out;
}

function vertexPoint(entity, key) {
  return typeof key === 'number' ? geom.rectangleCorner(entity, key) : entity[key];
}

const vertexId = (entity, key) => `${entity.id}:${key}`;

function parseVertexId(id) {
  const cut = id.lastIndexOf(':');
  const entity = entities.find(e => e.id === id.slice(0, cut));
  const raw = id.slice(cut + 1);
  return entity ? { entity, key: raw === 'a' || raw === 'b' ? raw : Number(raw) } : null;
}

function clearSelection() {
  selected.clear();
  selectedVertices.clear();
}

function drawHandles() {
  handleLayer.replaceChildren();
  if (tool !== 'pick') return;
  const size = 3.5 / pixelsPerMm();
  // 框选中的顶点画成实心方块，跟整图元选中的白框区分开
  for (const id of selectedVertices) {
    const parsed = parseVertexId(id);
    if (!parsed) continue;
    const p = vertexPoint(parsed.entity, parsed.key);
    handleLayer.appendChild(createSvg('rect', {
      x: toSvgX(p.x) - size, y: toSvgY(p.y) - size, width: size * 2, height: size * 2,
      fill: '#e8890c', stroke: '#a35b00', 'stroke-width': 1.2, 'vector-effect': 'non-scaling-stroke',
    }));
  }
  for (const entity of entities) {
    if (!selected.has(entity.id)) continue;
    if (entity.type === 'pins') {
      const t = entity.angle * Math.PI / 180;
      for (const [lx, ly] of [[-4, 0], [4, 0]]) {
        const px = entity.center.x + lx * Math.cos(t) - ly * Math.sin(t);
        const py = entity.center.y + lx * Math.sin(t) + ly * Math.cos(t);
        handleLayer.appendChild(createSvg('circle', {
          cx: toSvgX(px), cy: toSvgY(py), r: size,
          fill: lx > 0 ? '#1a73e8' : '#fff', stroke: '#1a73e8',
          'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke',
        }));
      }
      continue;
    }
    for (const handle of vertexHandles(entity)) {
      handleLayer.appendChild(createSvg('rect', {
        x: toSvgX(handle.point.x) - size, y: toSvgY(handle.point.y) - size,
        width: size * 2, height: size * 2, fill: '#fff', stroke: '#1a73e8',
        'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke',
      }));
    }
    if (entity.type === 'rect') {          // 转向把手：跟销孔那个一样，拖它转
      const h = rectHandle(entity);
      handleLayer.appendChild(createSvg('circle', {
        cx: toSvgX(h.x), cy: toSvgY(h.y), r: size,
        fill: '#1a73e8', stroke: '#fff', 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke',
      }));
    }
  }
}

// 鼠标是不是压在一个选中图元的顶点上
// 点到哪一组销孔上（离任一孔心 4 mm 内算中）
function pinsHit(point) {
  const reach = 4 + 6 / pixelsPerMm();
  for (const entity of entities) {
    if (entity.type !== 'pins') continue;
    for (const h of pinHolesOf(entity)) {
      if (Math.hypot(h.center.x - point.x, h.center.y - point.y) <= reach) return entity;
    }
    if (Math.hypot(entity.center.x - point.x, entity.center.y - point.y) <= reach) return entity;
  }
  return null;
}

function handleHit(point) {
  if (tool !== 'pick') return null;
  const reach = 9 / pixelsPerMm();
  for (const id of selectedVertices) {          // 框选中的顶点优先，好整批一起拖
    const parsed = parseVertexId(id);
    if (!parsed) continue;
    const p = vertexPoint(parsed.entity, parsed.key);
    if (Math.hypot(p.x - point.x, p.y - point.y) <= reach) return parsed;
  }
  for (const entity of entities) {
    if (!selected.has(entity.id)) continue;
    for (const handle of vertexHandles(entity)) {
      if (Math.hypot(handle.point.x - point.x, handle.point.y - point.y) <= reach) {
        return { entity, key: handle.key };
      }
    }
  }
  return null;
}

// 落一批顶点的新位置。
// 线段直接挪那一端。矩形要先换算到它自己的坐标系里重定宽高、再把中心挪回去 ——
// 于是拖一个角是改尺寸，拖两个角还是矩形，拖满四个就是平移，永远不会变成平行四边形；
// 转过的矩形也一样，a/b 始终是「未旋转的框」，转角单独存。
function applyVertexMoves(moves) {
  for (const [id, byKey] of moves) {
    const entity = entities.find(e => e.id === id);
    if (!entity) continue;
    if (entity.type === 'segment') {
      for (const [key, p] of byKey) {
        if (isSymAxis(entity)) {          // 轴只上下平移，始终保持横贯画布的水平线
          entity.a = { x: 0, y: p.y };
          entity.b = { x: WIDTH, y: p.y };
        } else {
          entity[key] = p;
        }
      }
      continue;
    }
    const local = [0, 1, 2, 3].map(i => geom.toRectLocal(entity, geom.rectangleCorner(entity, i)));
    for (const [key, p] of byKey) local[key] = geom.toRectLocal(entity, p);
    // 定框只用「动过的角 + 它们的对角」：单个角往里拖才会真的缩。
    // 要是拿四个角一起取包围盒，另外三个角会按原位把框撑住，往里拖等于没拖。
    // 对角如果也被拖过，它在 local 里已经是新位置，直接取用即可。
    const used = [];
    for (const key of byKey.keys()) used.push(local[key], local[(key + 2) % 4]);
    const lx0 = Math.min(...used.map(q => q.x)), lx1 = Math.max(...used.map(q => q.x));
    const ly0 = Math.min(...used.map(q => q.y)), ly1 = Math.max(...used.map(q => q.y));
    const hw = (lx1 - lx0) / 2, hh = (ly1 - ly0) / 2;
    const center = geom.fromRectLocal(entity, { x: (lx0 + lx1) / 2, y: (ly0 + ly1) / 2 });
    entity.a = { x: center.x - hw, y: center.y - hh };
    entity.b = { x: center.x + hw, y: center.y + hh };
  }
}

// 鼠标吸附到的端点：画个圈提示
function drawHover() {
  hoverLayer.replaceChildren();
  // 网格吸附有格线本身作参照，再套个圈纯属添乱，只有吸到端点才画
  if (!hovering || hovering.kind !== 'endpoint') return;
  const radius = 4 / pixelsPerMm();
  hoverLayer.appendChild(createSvg('circle', {
    cx: toSvgX(hovering.point.x), cy: toSvgY(hovering.point.y), r: radius,
    fill: 'none', stroke: '#e8890c', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke',
  }));
  hoverLayer.appendChild(createSvg('circle', {
    cx: toSvgX(hovering.point.x), cy: toSvgY(hovering.point.y), r: 2 / pixelsPerMm(), fill: '#e8890c',
  }));
}

function render() {
  drawGrid();
  redLayer.replaceChildren();
  blackLayer.replaceChildren();
  for (const entity of derivedEntities()) drawEntity(redLayer, entity);
  for (const { entity, alpha } of displayEntities()) {
    if (entity.type === 'pins') drawPins(entity, alpha);   // 销孔是切割形状，固定画在红层
    else drawEntity(entity.color === 'red' ? redLayer : blackLayer, entity, alpha);
  }
  if (placing) drawPins({ ...placing, id: 'placing', color: 'red' });
  drawPoints();
  drawHandles();
  drawPreview();
  drawBand();
  drawHover();
  updateViewBox();
  syncSymBox();          // 撤销/切档/导入都可能把轴改没了，勾选框跟着轴走
  setProps();
}

function persist() {
  nowSlot().entities = entities;
  nowSlot().view = view;
  nowSlot().sym = symEnabled;
  store.saveData(data);
}

// 吸到了就写清楚吸到什么，别让人猜那个圈什么意思
function coordText(snapped, point = snapped.point) {
  const name = { endpoint: '端点', grid: '网格', ortho: '正交' }[snapped.kind] || '';
  const body = `${point.x.toFixed(1)} , ${point.y.toFixed(1)} mm`;
  return name ? `${name}  ${body}` : body;
}

function showTip(event, text) {
  tip.textContent = text;
  tip.style.display = 'block';
  tip.style.left = `${event.clientX + 14}px`;
  tip.style.top = `${event.clientY + 14}px`;
}

function pointerToModel(event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const local = point.matrixTransform(svg.getScreenCTM().inverse());
  return { x: local.x, y: HEIGHT - local.y };
}

// 存快照。拖顶点是"先改后记"，得把动手之前的那份塞进历史。
function rememberValue(snapshot) {
  history.push(snapshot);
  if (history.length > 60) history.shift();
  future.length = 0;
}

function remember() { rememberValue(JSON.stringify(entities)); }

function deleteSelection() {
  if (!selected.size) return;
  remember();
  entities = entities.filter(entity => !selected.has(entity.id));
  clearSelection();
  persist();
  render();
}

function undo() {
  if (!history.length) return;
  future.push(JSON.stringify(entities));
  entities = JSON.parse(history.pop());
  clearSelection();
  persist();
  render();
}

function redo() {
  if (!future.length) return;
  history.push(JSON.stringify(entities));
  entities = JSON.parse(future.pop());
  clearSelection();
  persist();
  render();
}

function hitTest(point) {
  const tolerance = snapTolerance() * 1.2;
  let hit = null;
  let best = tolerance;
  for (const entity of entities) {
    if (entity.type === 'pins') {
      for (const h of pinHolesOf(entity)) {
        const d = Math.hypot(h.center.x - point.x, h.center.y - point.y);
        if (d < best + 4) { best = 0; hit = entity; }
      }
      continue;
    }
    const segments = entity.type === 'segment' ? [entity] : geom.rectangleEdges(entity);
    for (const s of segments) {
      const d = geom.distanceToSegment(point, s);
      if (d < best) { best = d; hit = entity; }
    }
  }
  return hit;
}

function selectAt(point, addToSelection) {
  const hit = hitTest(point);
  if (addToSelection) {
    if (hit) selected.has(hit.id) ? selected.delete(hit.id) : selected.add(hit.id);
  } else {
    clearSelection();
    if (hit) selected.add(hit.id);
  }
  render();
}

// 框选到的顶点：只有黑线两端和矩形四角进圈
function bandSelect(start, end, addToSelection) {
  const x0 = Math.min(start.x, end.x), x1 = Math.max(start.x, end.x);
  const y0 = Math.min(start.y, end.y), y1 = Math.max(start.y, end.y);
  if (!addToSelection) clearSelection();
  for (const { entity, key } of selectableVertices()) {
    const p = vertexPoint(entity, key);
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) {
      selectedVertices.add(vertexId(entity, key));
    }
  }
  render();
}

// 方向键微调：选中顶点就挪顶点，只选中销孔就整组挪。基准步长 0.1 mm。
let lastNudge = 0;
function nudgeSelection(dx, dy) {
  if (!selectedVertices.size && !selected.size) return;
  if (Date.now() - lastNudge > 700) remember();   // 连按一串算一步，别把撤销挤爆
  lastNudge = Date.now();
  if (selectedVertices.size) {
    const moves = new Map();
    for (const id of selectedVertices) {
      const parsed = parseVertexId(id);
      if (!parsed) continue;
      const p = vertexPoint(parsed.entity, parsed.key);
      if (!moves.has(parsed.entity.id)) moves.set(parsed.entity.id, new Map());
      moves.get(parsed.entity.id).set(parsed.key, clampToCanvas({ x: p.x + dx, y: p.y + dy }));
    }
    applyVertexMoves(moves);
  } else {
    for (const entity of entities) {
      if (!selected.has(entity.id)) continue;
      if (entity.type === 'pins') {
        entity.center = clampToCanvas({ x: entity.center.x + dx, y: entity.center.y + dy });
      } else if (entity.type === 'rect') {   // 整块平移，仍是矩形
        for (const k of ['a', 'b']) {
          entity[k] = clampToCanvas({ x: entity[k].x + dx, y: entity[k].y + dy });
        }
      }
    }
  }
  persist();
  render();
}

// 微调旋转：销孔组件和矩形都能转（线段没有转角，转动它就是挪端点）
function rotateSelection(deg) {
  const targets = rotatableSelection();
  if (!targets.length) return;
  if (Date.now() - lastNudge > 700) remember();
  lastNudge = Date.now();
  for (const t of targets) t.angle = (t.angle || 0) + deg;
  persist();
  render();
}

const rotatableSelection = () => entities.filter(e => selected.has(e.id)
  && (e.type === 'pins' || e.type === 'rect'));

function updateCursor(handle = null) {
  svg.style.cursor = panning || pinch ? 'grabbing'
    : tool !== 'pick' ? 'crosshair'
    : handle ? 'move' : 'default';
}

function twoPointerPoints() {
  return [...activePointers.values()].slice(0, 2).map(pointerToModel);
}

function startPinch() {
  const [a, b] = twoPointerPoints();
  pinch = {
    distance: Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-6),
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    view: { ...view },
  };
  updateCursor();
}

function cancelDrag() {
  if (!dragging && !band) return;
  dragging = null;
  band = null;
  render();
}

// 指针抬起就把它从表里摘掉，两个以上才叫缩放。
// 中途被系统手势吞掉 up 的话，表里会留下幽灵手指，缩放就会一直"跟着走"没完。
function releasePointer(event) {
  if (!activePointers.delete(event.pointerId)) return;
  if (pinch && activePointers.size < 2) { pinch = null; updateCursor(); }
}

svg.addEventListener('pointerdown', event => {
  activePointers.set(event.pointerId, event);
  try { svg.setPointerCapture(event.pointerId); } catch (err) { /* 合成事件无真指针 */ }

  // 第二根手指一落下来就放弃正在画的那条，避免缩放后留下一个点
  if (activePointers.size === 2) { cancelDrag(); panning = null; startPinch(); return; }
  if (activePointers.size > 2) { pinch = null; return; }

  if (event.button === 1 || event.shiftKey) {
    panning = { point: pointerToModel(event), x: view.x, y: view.y };
    updateCursor();
    return;
  }
  if (event.button !== 0) return;
  const point = pointerToModel(event);
  if (placingKind) {                      // 放置销孔：按下定坐标，拖出去定方向
    placing = { kind: placingKind, center: snapPinCenter(point, event), angle: 0, color: 'red' };
    render();
    return;
  }
  if (tool === 'pick') {
    const pin = pinsHit(point);           // 先看是不是要拖销孔
    if (pin) {
      const t = pin.angle * Math.PI / 180;
      const hx = pin.center.x + 4 * Math.cos(t), hy = pin.center.y + 4 * Math.sin(t);
      const grabRotate = Math.hypot(point.x - hx, point.y - hy) <= 9 / pixelsPerMm();
      clearSelection();
      selected.add(pin.id);
      dragging = { mode: grabRotate ? 'pins-rotate' : 'pins-move', entity: pin,
                   grab: { x: point.x - pin.center.x, y: point.y - pin.center.y },
                   before: JSON.stringify(entities) };
      render();
      return;
    }
    const handle = handleHit(point);
    if (handle) {                         // 顶点优先：调尺寸比转更常用，别被把手抢走
      const id = vertexId(handle.entity, handle.key);
      if (!selectedVertices.has(id)) {    // 抓的不是框选里那批，就只拖这一个
        clearSelection();
        selected.add(handle.entity.id);
      }
      const group = selectedVertices.has(id) ? [...selectedVertices] : [id];
      dragging = { mode: 'vertex', entity: handle.entity, key: handle.key,
                   start: vertexPoint(handle.entity, handle.key),
                   base: group.map(v => {
                     const parsed = parseVertexId(v);
                     return [v, vertexPoint(parsed.entity, parsed.key)];
                   }),
                   before: JSON.stringify(entities) };
      render();
      return;
    }
    const rotor = rectHandleHit(point);
    if (rotor) {                          // 拖转向把手
      clearSelection();
      selected.add(rotor.id);
      dragging = { mode: 'rect-rotate', entity: rotor, before: JSON.stringify(entities) };
      render();
      return;
    }
    band = { start: point, end: point, moved: false };
    return;
  }

  const snapped = geom.snapPoint(point, {
    points: allEndpoints(),
    tolerance: snapTolerance(),
    grid: GRID_MINOR,
    gridTolerance: gridSnapTolerance(),
    enabled: snapEnabled && !event.altKey,
  });
  snapped.point = clampToCanvas(snapped.point);
  dragging = {
    start: snapped.point,
    kind: snapped.kind,
    shape: {
      type: tool.startsWith('rect') || tool === 'relief-red' ? 'rect' : 'segment',
      ...(tool === 'relief-red' ? { relief: geom.RELIEF } : {}),
      a: snapped.point,
      b: snapped.point,
    },
  };
  render();
});

svg.addEventListener('pointermove', event => {
  // 手指已经抬起（buttons 归零）却还在表里，说明 up 被系统吞了，就地摘掉，
  // 否则留着的那根手指一动，还在按两根手指的算法缩放——就是"缩放不停"的来源
  if (event.buttons === 0 && activePointers.has(event.pointerId)) releasePointer(event);

  if (activePointers.has(event.pointerId)) activePointers.set(event.pointerId, event);

  if (pinch) {
    const [a, b] = twoPointerPoints();
    const factor = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-6) / pinch.distance;
    zoomAt(pinch.view, pinch.center, factor);
    updateViewBox();
    return;
  }

  const point = pointerToModel(event);
  if (panning) {
    view.x = panning.x - (point.x - panning.point.x);
    view.y = panning.y - (point.y - panning.point.y);
    updateViewBox();
    return;
  }

  if (band) {                             // 框选：拉橡皮筋
    band.end = clampToCanvas(point);
    band.moved = band.moved || Math.hypot(band.end.x - band.start.x, band.end.y - band.start.y) > 3 / pixelsPerMm();
    render();
    return;
  }

  if (placing) {                          // 方向 = 从落点指向鼠标；开吸附才吸到 5°
    const dx = point.x - placing.center.x, dy = point.y - placing.center.y;
    if (Math.hypot(dx, dy) > 3 / pixelsPerMm()) {
      const raw = Math.atan2(dy, dx) * 180 / Math.PI;
      placing.angle = pinAngle(raw, event);
    }
    showTip(event, `${placing.angle.toFixed(1)}°  ${placing.center.x.toFixed(1)} , ${placing.center.y.toFixed(1)} mm`);
    render();
    return;
  }

  if (dragging && dragging.mode === 'pins-move') {
    dragging.entity.center = snapPinCenter(
      { x: point.x - dragging.grab.x, y: point.y - dragging.grab.y }, event);
    showTip(event, `${dragging.entity.center.x.toFixed(1)} , ${dragging.entity.center.y.toFixed(1)} mm`);
    render();
    return;
  }
  if (dragging && dragging.mode === 'pins-rotate') {
    const e = dragging.entity;
    const raw = Math.atan2(point.y - e.center.y, point.x - e.center.x) * 180 / Math.PI;
    e.angle = pinAngle(raw, event);
    showTip(event, `${e.angle.toFixed(1)}°`);
    render();
    return;
  }
  if (dragging && dragging.mode === 'rect-rotate') {
    const center = geom.rectCenter(dragging.entity);
    const raw = Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI;
    dragging.entity.angle = pinAngle(raw, event);
    showTip(event, `${dragging.entity.angle.toFixed(1)}°`);
    render();
    return;
  }

  // 拖顶点：按画线的规则吸附，只是要把自己这个图元从候选里刨掉
  if (dragging && dragging.mode === 'vertex') {
    const snapped = geom.snapPoint(point, {
      points: allEndpoints(dragging.entity.id),
      tolerance: snapTolerance(),
      grid: GRID_MINOR,
      gridTolerance: gridSnapTolerance(),
      enabled: snapEnabled && !event.altKey,
    });
    const moved = clampToCanvas(snapped.point);
    const dx = moved.x - dragging.start.x, dy = moved.y - dragging.start.y;
    const moves = new Map();
    for (const [id, base] of dragging.base) {
      const parsed = parseVertexId(id);
      if (!parsed) continue;
      if (!moves.has(parsed.entity.id)) moves.set(parsed.entity.id, new Map());
      moves.get(parsed.entity.id).set(parsed.key,
        clampToCanvas({ x: base.x + dx, y: base.y + dy }));
    }
    applyVertexMoves(moves);
    dragging.kind = snapped.kind;
    showTip(event, coordText(snapped, moved));
    render();
    return;
  }

  if (dragging) {
    const snapped = geom.snapPoint(point, {
      points: allEndpoints(),
      from: dragging.start,
      tolerance: snapTolerance(),
      grid: GRID_MINOR,
      gridTolerance: gridSnapTolerance(),
      orthoDeg: ORTHO_DEGREES,
      enabled: snapEnabled && !event.altKey,
    });
    snapped.point = clampToCanvas(snapped.point);
    dragging.shape.b = snapped.point;
    dragging.kind = snapped.kind;
    showTip(event, coordText(snapped));
    render();
    return;
  }

  // 悬停就按画线的同一套规则吸一遍：起笔之前就能看见这一下会落在哪
  const snapped = geom.snapPoint(point, {
    points: allEndpoints(),
    tolerance: snapTolerance(),
    grid: GRID_MINOR,
    gridTolerance: gridSnapTolerance(),
    enabled: snapEnabled && !event.altKey,
  });
  hovering = snapped.snapped ? { point: snapped.point, kind: snapped.kind } : null;
  const key = hovering ? `${hovering.kind}:${hovering.point.x},${hovering.point.y}` : 'none';
  showTip(event, coordText(snapped));
  if (key !== hoverKey) { hoverKey = key; drawHover(); }
  updateCursor(handleHit(point));
});

// 指针可能在我们管不着的地方抬起（拖到工具栏上、系统手势打断），
// 这几个兜底监听保证表里不会留下幽灵手指
window.addEventListener('pointerup', releasePointer);
window.addEventListener('pointercancel', releasePointer);
window.addEventListener('blur', () => {
  activePointers.clear();
  pinch = null;
  dragging = null;
  band = null;
  panning = null;
  updateCursor();
});

svg.addEventListener('pointerup', event => {
  releasePointer(event);
  if (pinch) {
    if (activePointers.size < 2) { pinch = null; updateCursor(); }
    return;
  }
  if (panning) { panning = null; updateCursor(); persist(); return; }
  if (band) {                             // 没拉出距离就是普通点选
    const b = band;
    band = null;
    if (b.moved) bandSelect(b.start, b.end, event.ctrlKey);
    else selectAt(b.start, event.ctrlKey);
    return;
  }
  if (placing) {                          // 落定一组销孔
    remember();
    entities.push({ id: `p${nextId++}`, type: 'pins', kind: placing.kind,
                    center: placing.center, angle: placing.angle, color: 'red' });
    placing = null;
    placingKind = null;
    for (const b of document.querySelectorAll('#pins button')) b.classList.remove('on');
    persist();
    render();
    return;
  }
  if (!dragging) return;
  if (dragging.mode === 'pins-move' || dragging.mode === 'pins-rotate'
      || dragging.mode === 'rect-rotate') {
    if (JSON.stringify(entities) !== dragging.before) { rememberValue(dragging.before); persist(); }
    dragging = null;
    render();
    return;
  }
  if (dragging.mode === 'vertex') {
    if (JSON.stringify(entities) !== dragging.before) {
      rememberValue(dragging.before);
      persist();
    }
    dragging = null;
    render();
    return;
  }
  const { a, b } = dragging.shape;
  if (Math.hypot(b.x - a.x, b.y - a.y) > 0.3) {
    remember();
    entities.push({
      id: `e${nextId++}`,
      type: dragging.shape.type,
      color: tool.endsWith('red') ? 'red' : 'black',
      ...(tool === 'relief-red' ? { relief: geom.RELIEF } : {}),
      a, b,
    });
    persist();
  }
  dragging = null;
  render();
});

svg.addEventListener('pointercancel', event => {
  activePointers.delete(event.pointerId);
  if (pinch && activePointers.size < 2) pinch = null;
  cancelDrag();
  panning = null;
  band = null;
  updateCursor();
});

svg.addEventListener('wheel', event => {
  event.preventDefault();
  // 按实际滚动量缩放。写死"每个事件 ×1.12"是不行的：触控板/触屏的捏合会被浏览器
  // 拆成几十上百个带 ctrlKey 的小 delta 事件，一路乘下去整张图会缩成一个点。
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;  // 行/页 → 像素
  // 负号：往下滚是缩小、往上滚是放大，跟浏览器和常见画图软件一致；
  // 触控板捏合张开会给负 delta，取负之后正好是放大
  const factor = Math.exp(-event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.0015));
  zoomAt({ ...view }, pointerToModel(event), factor);
  updateViewBox();
  render();
  persist();
}, { passive: false });

svg.addEventListener('pointerleave', () => {
  tip.style.display = 'none';
  hovering = null;
  hoverKey = null;
  drawHover();
  updateCursor();
});

svg.addEventListener('contextmenu', event => event.preventDefault());

// 1-5 切工具，6 开关吸附；方向键微调位置，方括号微调转角
const TOOL_KEYS = ['black', 'red', 'rect-black', 'rect-red', 'pick'];
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

document.addEventListener('keydown', event => {
  const mod = event.ctrlKey || event.metaKey;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undo();
    return;
  }
  if (!mod && TOOL_KEYS[+event.key - 1]) {
    setTool(TOOL_KEYS[+event.key - 1]);
    return;
  }
  if (!mod && event.key === '6') {
    const box = document.getElementById('snap');
    box.checked = !box.checked;
    snapEnabled = box.checked;
    return;
  }
  if (!mod && event.key in ARROWS) {
    event.preventDefault();
    const step = event.shiftKey ? 1 : 0.1;      // 微调默认 0.1 mm，Shift 走整毫米
    const [sx, sy] = ARROWS[event.key];
    nudgeSelection(sx * step, sy * step);
    return;
  }
  if (event.key === '[' || event.key === ']') {
    event.preventDefault();
    const fine = event.altKey ? 0.1 : event.shiftKey ? 10 : 1;
    rotateSelection((event.key === ']' ? 1 : -1) * fine);
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();   // 没选中东西的时候也别让 Backspace 触发浏览器后退
    deleteSelection();
  } else if (event.key === 'Escape') {
    placing = null;
    placingKind = null;
    for (const b of document.querySelectorAll('#pins button')) b.classList.remove('on');
    clearSelection();
    dragging = null;
    band = null;
    render();
  }
});

// 销孔调色板：每个预设一个小按钮，图上带缩略示意
function buildPinPalette() {
  const box = document.getElementById('pins');
  if (!box) return;
  for (const [kind, preset] of Object.entries(geom.PIN_PRESETS)) {
    const button = document.createElement('button');
    button.title = preset.name;
    const xs = preset.holes.map(h => h[0]), ys = preset.holes.map(h => h[1]);
    const x0 = Math.min(...xs) - 3, x1 = Math.max(...xs) + 3;
    const y0 = Math.min(...ys) - 3, y1 = Math.max(...ys) + 3;
    const w = x1 - x0, h = y1 - y0;
    const S = 34 / Math.max(w, h);
    const mark = preset.holes.map(([x, y, own = 0]) => {
      const w = own ? 5.6 : 2.2, h = own ? 2.2 : 5.6;
      return `<rect x="${(x - x0) * S - w / 2}" y="${(y1 - y) * S - h / 2}"`
           + ` width="${w}" height="${h}" rx="1"/>`;
    }).join('');
    button.innerHTML = `<svg width="${(w * S).toFixed(1)}" height="${(h * S).toFixed(1)}" viewBox="0 0 ${(w * S).toFixed(1)} ${(h * S).toFixed(1)}"`
      + ` fill="none" stroke="#d93025" stroke-width="1.1">${mark}</svg>`;
    button.addEventListener('click', () => {
      const wasOn = placingKind === kind;
      setTool('pick');
      placingKind = wasOn ? null : kind;   // 再点一下取消
      for (const b of box.querySelectorAll('button')) b.classList.toggle('on', b === button && placingKind);
      updateCursor();
    });
    box.appendChild(button);
  }
}
buildPinPalette();

// 换工具：工具栏高亮、销孔调色板选中态、鼠标样式都跟着走
function setTool(name) {
  placingKind = null;
  tool = name;
  for (const b of document.querySelectorAll('#pins button')) b.classList.remove('on');
  for (const other of document.querySelectorAll('#bar button[data-tool]')) {
    other.classList.toggle('on', other.dataset.tool === name);
  }
  updateCursor();
  render();
}

for (const button of document.querySelectorAll('#bar button[data-tool]')) {
  button.addEventListener('click', () => setTool(button.dataset.tool));
}

document.getElementById('undo').addEventListener('click', undo);
document.getElementById('redo').addEventListener('click', redo);
document.getElementById('delete').addEventListener('click', deleteSelection);
document.getElementById('snap').addEventListener('change', event => { snapEnabled = event.target.checked; });
document.getElementById('grid').addEventListener('change', event => { gridEnabled = event.target.checked; render(); });
document.getElementById('sym').addEventListener('change', event => {
  remember();
  symEnabled = event.target.checked;
  if (symEnabled) ensureSymAxis();      // 轴上没线就打一条上去，跟别的黑线一样吃刀
  persist();
  render();
});
document.getElementById('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ slot: data.current, sym: symEnabled, entities }, null, 1)],
                        { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${data.current}.json`;
  link.click();
});

document.getElementById('import').addEventListener('click', () => {
  document.getElementById('file').click();
});

document.getElementById('file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed.entities)) throw new Error('结构不对');
    remember();
    entities = parsed.entities;
    symEnabled = parsed.sym === true;
    clearSelection();
    persist();
    render();
  } catch (err) {
    alert('导入失败：不是本工具导出的 JSON');
  }
});

document.getElementById('fit').addEventListener('click', () => {
  view = fitView();
  updateViewBox();
  persist();
});

function refreshSlotSelect() {
  slotSelect.replaceChildren();
  for (const name of Object.keys(data.slots)) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    option.selected = name === data.current;
    slotSelect.appendChild(option);
  }
}

slotSelect.addEventListener('change', () => {
  persist();
  data.current = slotSelect.value;
  entities = currentSlot().entities;
  symEnabled = currentSlot().sym === true;
  view = currentSlot().view || fitView();
  clearSelection();
  history = [];
  render();
});

document.getElementById('slot-new').addEventListener('click', () => {
  const name = prompt('新存档名', `档${Object.keys(data.slots).length + 1}`);
  if (!name || data.slots[name]) return;
  persist();
  store.createSlot(data, name);
  entities = currentSlot().entities;
  symEnabled = false;
  view = fitView();
  clearSelection();
  history = [];
  store.saveData(data);
  refreshSlotSelect();
  render();
});

document.getElementById('slot-rename').addEventListener('click', () => {
  const name = prompt('改成', data.current);
  if (!name || name === data.current || data.slots[name]) return;
  data.slots[name] = data.slots[data.current];
  delete data.slots[data.current];
  data.current = name;
  store.saveData(data);
  refreshSlotSelect();
});

document.getElementById('slot-del').addEventListener('click', () => {
  if (Object.keys(data.slots).length <= 1) { alert('至少留一个存档'); return; }
  if (!confirm(`删除存档「${data.current}」？`)) return;
  store.removeSlot(data, data.current);
  entities = currentSlot().entities;
  symEnabled = currentSlot().sym === true;
  view = currentSlot().view || fitView();
  clearSelection();
  history = [];
  store.saveData(data);
  refreshSlotSelect();
  render();
});

window.addEventListener('beforeunload', persist);

refreshSlotSelect();
updateCursor();
render();

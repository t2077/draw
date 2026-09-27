#!/usr/bin/env python
"""把画线工具导出的 JSON 转成 DXF —— 规矩照抄 dxf/export_red_dxf.py：

  1) 只导红线（成品轮廓）。黑线是刀路中心线，不进 DXF。
     红线 = 屏幕上的那圈红：黑线派生出的刀路（距黑线恰 KERF mm）
            + 存档里手画的红线。
  2) 裁进 195×95 料片矩形。贴画布边界的黑线，其刀路会外扩 1 mm 落到料片外，
     那种要么整段裁掉、要么在边界处切断。
  3) 只有 Layer 0 一个图层，R2000，单位 mm，实体只有 LINE。

派生刀路不重写算法：把 js/geom.js 交给 node 现跑它的 roundedOffset，
保证 DXF 里的刀路和屏幕上看到的是同一份代码算出来的。

用法：
  python json2dxf.py 导入的.json [输出.dxf] [--preview]
"""

import json
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import ezdxf

SHEET_W, SHEET_H = 195.0, 95.0
KERF_RADIUS = 1.0
EPS = 1e-9

RUNNER = """
import * as geom from './geom.js';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const { entities, sym } = JSON.parse(raw);

// 对称：画线工具里镜像那份是现算的，不进存档。这里照着同一套规则再算一遍，
// 否则 DXF 只有半张图。轴（带 sym 标记的那条黑线段）不参加镜像 —— 关于它自己
// 镜像还是它自己 —— 但它跟别的黑线一样是切割轮廓，刀路照算。
const isAxis = e => e.type === 'segment' && e.color === 'black' && e.sym === true;
const axis = sym ? entities.find(isAxis) : null;
const mirror = (e, y0) => (e.type === 'pins'
  ? { ...e, center: { x: e.center.x, y: 2 * y0 - e.center.y }, angle: -e.angle }
  : { ...e, a: { x: e.a.x, y: 2 * y0 - e.a.y }, b: { x: e.b.x, y: 2 * y0 - e.b.y } });
const all = axis ? entities.concat(entities.filter(e => !isAxis(e)).map(e => mirror(e, axis.a.y)))
                 : entities;

const segments = [];
for (const e of all) {
  if (e.color !== 'black') continue;
  if (e.type === 'segment') segments.push({ a: e.a, b: e.b });
  else segments.push(...geom.rectangleEdges(e));
}
const d = Number(process.argv[2]);
process.stdout.write(JSON.stringify(
  segments.length ? geom.roundedOffset(segments, d) : []));
"""


# ---------------- 裁进料片矩形 ----------------
def clip_seg(p, q):
    """Liang–Barsky：线段裁到 [0,W]×[0,H]，返回两端点或 None。"""
    px, py = p
    qx, qy = q
    dx, dy = qx - px, qy - py
    t0, t1 = 0.0, 1.0
    for pp, qq in ((-dx, px), (dx, SHEET_W - px), (-dy, py), (dy, SHEET_H - py)):
        if abs(pp) < 1e-12:
            if qq < 0:
                return None
        else:
            t = qq / pp
            if pp < 0:
                if t > t1:
                    return None
                if t > t0:
                    t0 = t
            else:
                if t < t0:
                    return None
                if t < t1:
                    t1 = t
    if t1 - t0 < EPS:
        return None
    return ((px + dx * t0, py + dy * t0), (px + dx * t1, py + dy * t1))


def clip_arc(c, r, a0, a1):
    """圆弧裁到料片矩形：与四条边求交角，按角度切段，逐段取中点判内外。"""
    cx, cy = c
    angs = [a0, a1]
    for xv in (0.0, SHEET_W):
        d = xv - cx
        if abs(d) <= r:
            h = math.sqrt(max(0.0, r * r - d * d))
            for yv in (cy - h, cy + h):
                angs.append(math.atan2(yv - cy, d))
    for yv in (0.0, SHEET_H):
        d = yv - cy
        if abs(d) <= r:
            h = math.sqrt(max(0.0, r * r - d * d))
            for xv in (cx - h, cx + h):
                angs.append(math.atan2(xv - cx, d))
    two = 2 * math.pi
    cand = []
    for a in angs:
        t = a
        while t < a0 - 1e-9:
            t += two
        while t > a0 + two + 1e-9:
            t -= two
        if a0 - 1e-9 <= t <= a1 + 1e-9:
            cand.append(t)
    cand = sorted({round(t, 12) for t in cand})
    out = []
    for i in range(len(cand) - 1):
        m = (cand[i] + cand[i + 1]) / 2
        x, y = cx + r * math.cos(m), cy + r * math.sin(m)
        if -EPS <= x <= SHEET_W + EPS and -EPS <= y <= SHEET_H + EPS:
            out.append((cand[i], cand[i + 1]))
    return out


def norm_deg(rad):
    return math.degrees(rad) % 360.0


def kerf_from_geom(entities, sym):
    """让 node 加载项目里那份 geom.js，用同一个 roundedOffset 算刀路。"""
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("找不到 node：刀路要用 js/geom.js 现算，装了 node 再跑")
    geom_src = Path(__file__).resolve().parent / "js" / "geom.js"
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        shutil.copy(geom_src, tmp / "geom.js")
        (tmp / "package.json").write_text('{"type":"module"}', encoding="utf-8")
        (tmp / "run.mjs").write_text(RUNNER, encoding="utf-8")
        proc = subprocess.run(
            [node, str(tmp / "run.mjs"), repr(KERF_RADIUS)],
            input=json.dumps({"entities": entities, "sym": sym}),
            capture_output=True, text=True, encoding="utf-8",
        )
        if proc.returncode != 0:
            raise RuntimeError(f"node 跑 geom.js 失败：\n{proc.stderr}")
        return json.loads(proc.stdout)


# 销孔预设：跟 js/geom.js 的 PIN_PRESETS 一一对应（局部坐标，长圆孔 7 × 2.5，长轴沿局部 y）
SLOT_W, SLOT_L = 2.5, 4.7   # 跟 js/geom.js 保持一致
RELIEF = 0.07               # 掏角圆弧半径，跟 js/geom.js 的 RELIEF 保持一致
# 每项 [x, y, 自身转角]：0 = 长轴沿局部 y（竖），90 = 横。下挂那个是横的。
PIN_PRESETS = {
    "p4":  [[-4, 0, 0], [0, 0, 0], [4, 0, 0], [0, -6.7, 90]],
    "p3h": [[-4, 0, 0], [0, 0, 0], [4, 0, 0]],
    "p3v": [[-4, 0, 0], [4, 0, 0], [0, -6.7, 90]],
    "p2":  [[-4, 0, 0], [4, 0, 0]],
}


def relief_rect(center, angle_rad, hx, hy, d):
    """带转角的掏角矩形（销孔是斜的）：四条边 + 四个 r = d 的 180° 半圆。
    跟 js/geom.js 的 reliefRect 同一套。返回 (线段, 圆弧)，角度用弧度。"""
    co, si = math.cos(angle_rad), math.sin(angle_rad)

    def G(lx, ly):
        return (center[0] + lx * co - ly * si, center[1] + lx * si + ly * co)

    sp, tp = d / math.sqrt(2), d * math.sqrt(2)
    if hx <= tp or hy <= tp:
        k = [G(-hx, -hy), G(hx, -hy), G(hx, hy), G(-hx, hy)]
        return [(k[i], k[(i + 1) % 4]) for i in range(4)], []
    lines = [
        (G(-hx + tp, -hy), G(hx - tp, -hy)),
        (G(hx, -hy + tp), G(hx, hy - tp)),
        (G(hx - tp, hy), G(-hx + tp, hy)),
        (G(-hx, hy - tp), G(-hx, -hy + tp)),
    ]
    arcs = []
    for sx, sy in ((1, -1), (1, 1), (-1, 1), (-1, -1)):
        C = G(sx * (hx - sp), sy * (hy - sp))
        A = G(sx * hx, sy * (hy - tp))
        corner = G(sx * hx, sy * hy)
        aA = math.atan2(A[1] - C[1], A[0] - C[0])
        aC = math.atan2(corner[1] - C[1], corner[0] - C[0])
        turn = (aC - aA) % (2 * math.pi)
        a0 = aA if turn < math.pi else aA - math.pi   # 取经过角点的那半圆
        arcs.append((C, d, a0, a0 + math.pi))
    return lines, arcs


def pin_slot_edges(entity):
    """把一组销孔拆成边 + 掏角弧，跟主程序画的形状一致。返回 (线段, 圆弧)。"""
    t = math.radians(entity.get("angle", 0.0))
    c, s = math.cos(t), math.sin(t)
    cx, cy = entity["center"]["x"], entity["center"]["y"]
    hw, hl = SLOT_W / 2, SLOT_L / 2
    flipped = entity.get("mirrored", False)     # 镜像那份：本地 y 翻向，孔自身转角反向
    edges, arcs = [], []
    for lx, ly, own in PIN_PRESETS[entity.get("kind", "p4")]:
        if flipped:
            ly, own = -ly, -own
        ox, oy = cx + lx * c - ly * s, cy + lx * s + ly * c
        # 孔的朝向 = 组件转角 + 孔自己的转角。漏掉 t 的话，转过的组件导出来还是正的
        lines, acs = relief_rect((ox, oy), t + math.radians(own), hw, hl, RELIEF)
        edges.extend(lines)
        arcs.extend(acs)
    return edges, arcs


def is_sym_axis(e):
    return e.get("type") == "segment" and e.get("color") == "black" and e.get("sym") is True


def mirror_entity(e, y0):
    """关于水平线 y = y0 镜像，跟 js/geom.js 的 mirrorEntity 一致。"""
    if e["type"] == "pins":
        return {**e, "center": {"x": e["center"]["x"], "y": 2 * y0 - e["center"]["y"]},
                "angle": -e.get("angle", 0.0), "mirrored": True}
    return {**e, "a": {"x": e["a"]["x"], "y": 2 * y0 - e["a"]["y"]},
            "b": {"x": e["b"]["x"], "y": 2 * y0 - e["b"]["y"]}}


def effective_entities(data):
    """存档原样 + （开了对称时）镜像一份。轴自己不镜像：关于自己镜像还是自己。"""
    axis = next((e for e in data["entities"] if is_sym_axis(e)), None) if data.get("sym") else None
    if axis is None:
        return data["entities"]
    y0 = axis["a"]["y"]
    keep = [e for e in data["entities"] if not is_sym_axis(e)]
    return data["entities"] + [mirror_entity(e, y0) for e in keep]


def rect_corners(entity):
    """矩形存 { a, b, angle }：a、b 是未旋转的一对对角，整体绕中心转 angle 度。
    跟 js/geom.js 的 rectangleCorner 一致。"""
    x0, x1 = sorted((entity["a"]["x"], entity["b"]["x"]))
    y0, y1 = sorted((entity["a"]["y"], entity["b"]["y"]))
    c0x, c0y = (x0 + x1) / 2, (y0 + y1) / 2
    t = math.radians(entity.get("angle", 0.0))
    co, si = math.cos(t), math.sin(t)
    out = []
    for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        dx, dy = x - c0x, y - c0y
        out.append((c0x + dx * co - dy * si, c0y + dx * si + dy * co))
    return out


def relief_rect_path(entity):
    """掏角矩形：四条边（切点之间）+ 四个 r = relief 的 180° 半圆。
    圆心在角点沿对角线往内、每轴偏 relief/√2（即离角点 relief），半径 relief 时
    圆弧正好过角点，两端切点落在两条边上距角点 relief·√2。跟 js/geom.js 同一套。
    返回 (线段, 圆弧)，圆弧是 (圆心, 半径, 起始角, 终止角)，角度用弧度。"""
    x0, x1 = sorted((entity["a"]["x"], entity["b"]["x"]))
    y0, y1 = sorted((entity["a"]["y"], entity["b"]["y"]))
    return relief_rect(((x0 + x1) / 2, (y0 + y1) / 2), math.radians(entity.get("angle", 0.0)),
                       (x1 - x0) / 2, (y1 - y0) / 2, float(entity.get("relief", RELIEF)))


def red_sources(data, kerf):
    """待裁的候选：派生刀路 + 手画红线（插销多边形拆边、矩形拆四条边）。
    返回 (线段, 圆弧)。"""
    items = [((s["a"]["x"], s["a"]["y"]), (s["b"]["x"], s["b"]["y"]), "派生刀路")
             for s in kerf]
    arcs = []
    for e in effective_entities(data):
        if e.get("color") != "red":
            continue
        if e["type"] == "pins":
            p_edges, p_arcs = pin_slot_edges(e)
            items.extend((a, b, "销孔") for a, b in p_edges)
            arcs.extend((c, r, a0, a1, "销孔") for c, r, a0, a1 in p_arcs)
            continue
        if e["type"] == "segment":
            items.append(((e["a"]["x"], e["a"]["y"]), (e["b"]["x"], e["b"]["y"]), "手画红线"))
        elif e.get("relief"):
            lines, arcs_out = relief_rect_path(e)
            items.extend((a, b, "掏角矩形") for a, b in lines)
            arcs.extend((c, r, a0, a1, "掏角矩形") for c, r, a0, a1 in arcs_out)
        else:
            c = rect_corners(e)
            for i in range(4):
                items.append((c[i], c[(i + 1) % 4], "手画红线"))
    return items, arcs


def build(data, path):
    kerf = kerf_from_geom(data["entities"], data.get("sym") is True)
    items, arc_items = red_sources(data, kerf)

    kept, dropped, trimmed = [], 0, 0
    for p, q, src in items:
        c = clip_seg(p, q)
        if c is None:
            dropped += 1
            continue
        if (abs(c[0][0] - p[0]) > 1e-9 or abs(c[0][1] - p[1]) > 1e-9
                or abs(c[1][0] - q[0]) > 1e-9 or abs(c[1][1] - q[1]) > 1e-9):
            trimmed += 1
        kept.append((c[0], c[1], src))

    kept_arcs = []
    for c, r, a0, a1, src in arc_items:
        for s, e in clip_arc(c, r, a0, a1):
            kept_arcs.append((c, r, s, e, src))

    doc = ezdxf.new("R2000")
    doc.units = ezdxf.units.MM
    if "Defpoints" in doc.layers:
        doc.layers.remove("Defpoints")       # 只留 Layer 0
    msp = doc.modelspace()
    for p, q, _ in kept:
        msp.add_line(p, q, dxfattribs={"layer": "0"})
    for c, r, a0, a1, _ in kept_arcs:
        msp.add_arc(c, r, norm_deg(a0), norm_deg(a1), dxfattribs={"layer": "0"})
    doc.saveas(path)
    return dict(kerf=len(kerf), items=len(items), kept=len(kept),
                dropped=dropped, trimmed=trimmed,
                arcs=len(arc_items), kept_arcs=len(kept_arcs))


def layer_names(path):
    """从文件原文抓层名（readfile 的 layers 会把 Defpoints 补回来，不是文件内容）。"""
    raw = path.read_text(encoding="utf-8", errors="replace").splitlines()
    out, i = [], 0
    while i < len(raw) - 1:
        if raw[i].strip() == "AcDbLayerTableRecord":
            j = i + 1
            while j < len(raw) - 1:
                if raw[j].strip() == "2":
                    out.append(raw[j + 1].strip())
                    break
                j += 1
        i += 1
    return out


def audit(st, path):
    from ezdxf import bbox

    doc = ezdxf.readfile(path)
    msp = doc.modelspace()
    ext = bbox.extents(msp)
    return {
        "输出": path.name,
        "字节": path.stat().st_size,
        "DXF版本": doc.dxfversion,
        "单位码$INSUNITS": doc.header.get("$INSUNITS"),
        "文件内图层": layer_names(path),
        "实体所在图层": sorted({e.dxf.layer for e in msp}),
        "LINE数": len(msp.query("LINE")),
        "ARC数": len(msp.query("ARC")),
        "其它实体": [t for t in {e.dxftype() for e in msp} if t not in ("LINE", "ARC")],
        "裁剪": {
            "候选段": st["items"],
            "整段裁掉": st["dropped"],
            "截短": st["trimmed"],
            "掏角弧": st["arcs"],
            "留下弧": st["kept_arcs"],
        },
        "派生刀路段数": st["kerf"],
        "包围盒mm": [round(v, 3) for v in (ext.extmin.x, ext.extmin.y, ext.extmax.x, ext.extmax.y)],
        "跨度mm": [round(ext.extmax.x - ext.extmin.x, 3), round(ext.extmax.y - ext.extmin.y, 3)],
        "料片矩形mm": [SHEET_W, SHEET_H],
        "越界mm": round(max(0.0, -ext.extmin.x, -ext.extmin.y,
                           ext.extmax.x - SHEET_W, ext.extmax.y - SHEET_H), 6),
        "刀缝半径mm": KERF_RADIUS,
    }


def preview(path, png):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend

    # 不设中文字体的话标题里的汉字会变方框
    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False

    doc = ezdxf.readfile(path)
    fig = plt.figure(figsize=(16, 8))
    ax = fig.add_axes([0.02, 0.02, 0.96, 0.94])
    Frontend(RenderContext(doc), MatplotlibBackend(ax)).draw_layout(doc.modelspace(), finalize=True)
    ax.add_patch(plt.Rectangle((0, 0), SHEET_W, SHEET_H, fill=False, ec="#00e5ff", lw=1.2))
    ax.set_aspect("equal")
    ax.set_title(f"{path.name}   （青色框 = {SHEET_W:g} × {SHEET_H:g} 料片）")
    fig.savefig(png, dpi=140, facecolor="#1b1b1b")
    plt.close(fig)
    return png


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 1
    src = Path(args[0])
    # 默认叫 xxx_red.dxf：跟 dxf 那边 figure_red.dxf 一个命名习惯，
    # 也免得盖掉手上的 xxx.dxf（AutoCAD 开着的时候根本写不进去）
    dst = Path(args[1]) if len(args) > 1 else src.with_name(src.stem + "_red.dxf")
    data = json.loads(src.read_text(encoding="utf-8"))
    st = build(data, dst)
    rep = {"源": str(src), "输出": str(dst), "存档": data.get("slot", "?")}
    rep["audit"] = audit(st, dst)
    if "--preview" in sys.argv:
        p = preview(dst, dst.with_suffix(".png"))
        rep["预览"] = [p.name, p.stat().st_size]
    print(json.dumps(rep, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

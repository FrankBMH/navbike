// 导航用的纯计算：把高德的 steps 变成一条可跟踪的线 + 一串转向动作
// 这里不碰 React，也不发请求，方便单独看懂、单独改

export type P = { latitude: number; longitude: number };

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** 两点间球面距离（米） */
export function dist(a: P, b: P) {
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function parsePolyline(s: any): P[] {
  if (!s || typeof s !== 'string') return [];
  return s
    .split(';')
    .map(kv => {
      const [lng, lat] = kv.split(',').map(Number);
      return { latitude: lat, longitude: lng };
    })
    .filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
}

export type Maneuver = {
  action: string; // 右转 / 左转 / 向右前方行驶 / 到达目的地
  road: string; // 转进去的那条路（可能为空）
  at: P; // 动作发生的位置 = 这一段线的终点
  cum: number; // 这个动作距起点的累计米数
  step: number; // 属于第几段
};

export type Guide = {
  pts: P[]; // 整条路线的所有点（已去掉重复点）
  cum: number[]; // cum[i] = 从起点走到 pts[i] 的累计米数
  stepOf: number[]; // pts[i] 属于第几步
  stepEnd: number[]; // 第 i 步最后一点在 pts 里的下标
  man: Maneuver[]; // 每一步终点的动作
  total: number; // 全程米数
};

/** 把高德返回的 steps 摊平成一条线 + 动作表 */
export function buildGuide(steps: any[]): Guide {
  const pts: P[] = [];
  const cum: number[] = [];
  const stepOf: number[] = [];
  const stepEnd: number[] = [];
  const man: Maneuver[] = [];

  (steps || []).forEach((s, si) => {
    const raw = parsePolyline(s.polyline ?? s.polyline_5m);

    for (const p of raw) {
      const last = pts[pts.length - 1];
      if (last && dist(last, p) < 0.5) continue; // 高德常返回重复点，去掉
      const c = last ? cum[cum.length - 1] + dist(last, p) : 0;
      pts.push(p);
      cum.push(c);
      stepOf.push(si);
    }

    const lastIdx = Math.max(0, pts.length - 1);
    stepEnd.push(lastIdx);

    const act = String(s.navi?.action ?? '').trim();
    const assist = String(s.navi?.assistant_action ?? '');
    const arrive = /到达|抵达/.test(act + assist) && !act;

    man.push({
      action: arrive ? '到达目的地' : act || '继续直行',
      road: arrive ? '' : String((steps[si + 1] && steps[si + 1].road_name) || '').trim(),
      at: pts[lastIdx] ?? { latitude: 0, longitude: 0 },
      cum: cum[lastIdx] ?? 0,
      step: si,
    });
  });

  return { pts, cum, stepOf, stepEnd, man, total: cum[cum.length - 1] ?? 0 };
}

/**
 * 找当前 GPS 点落在路线的哪个位置。
 * 只从上次位置往前搜索一段，避免来回折返的路线把位置“吸”到对面车道。
 */
export function nearest(g: Guide, pos: P, from = 0) {
  const n = g.pts.length;
  if (!n) return { idx: 0, off: Infinity };

  const lo = Math.max(0, from - 40);
  const hi = Math.min(n - 1, from + 600);

  let best = lo;
  let bd = Infinity;
  for (let i = lo; i <= hi; i++) {
    const d = dist(pos, g.pts[i]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }

  // 窗口里都离得很远，可能是搜索范围不够（比如信号断了跳了一大段），全局再找一次
  if (bd > 120) {
    bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = dist(pos, g.pts[i]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
  }

  return { idx: best, off: bd };
}

/**
 * 全局最近点（不限窗口）。
 * 用来判断「某个中间点在路线上的什么位置」，跟当前位置比就知道过没过。
 */
export function nearestAll(g: Guide, pos: P) {
  const n = g.pts.length;
  if (!n) return { idx: 0, off: Infinity };
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < n; i++) {
    const d = dist(pos, g.pts[i]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return { idx: best, off: bd };
}

/** 30 米、380 米、1.2公里 这种说法 */
export function fmtDist(m: number) {
  const v = Math.max(0, m);
  if (v < 20) return `${Math.round(v)}米`;
  if (v < 1000) return `${Math.round(v / 10) * 10}米`;
  return `${(v / 1000).toFixed(1)}公里`;
}

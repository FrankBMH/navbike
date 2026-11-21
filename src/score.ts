const clamp = (v: number) => Math.max(0, Math.min(100, v));

export type Weights = { time: number; turn: number; road: number };

export const DEFAULT_WEIGHTS: Weights = { time: 0.45, turn: 0.35, road: 0.2 };

/** 把任意三项归一化成合计 1，这样界面怎么调都不会让总分跑出 100 */
export function normalize(w: Weights): Weights {
  const sum = w.time + w.turn + w.road;
  if (!(sum > 0)) return DEFAULT_WEIGHTS;
  return { time: w.time / sum, turn: w.turn / sum, road: w.road / sum };
}

const BIG = /(大道|大街|快速路|高速|环路|环线|主路|辅路|立交|桥|隧道)/;
const SMALL = /(巷|胡同|弄|村|小区|内部道路|便道|土路|无名|支路|街坊)/;

export function roadKind(name: any) {
  if (typeof name !== 'string' || name.trim().length < 2) return 'unknown';
  if (SMALL.test(name)) return 'small';
  if (BIG.test(name)) return 'big';
  return 'normal';
}

export type Part = { label: string; value: number };

export function grade(s: number) {
  if (s >= 85) return '优秀';
  if (s >= 70) return '良好';
  if (s >= 55) return '一般';
  return '偏差';
}

export function analyze(steps: any[], distance: number, duration: number, weights: Weights = DEFAULT_WEIGHTS) {
  let left = 0, right = 0, big = 0, small = 0, unknown = 0, normal = 0;

  for (const s of steps) {
    const a = `${s.navi?.action ?? ''}${s.navi?.assistant_action ?? ''}`;
    if (a.includes('左转')) left++;
    else if (a.includes('右转')) right++;
    const d = Number(s.step_distance) || 0;
    const k = roadKind(s.road_name);
    if (k === 'big') big += d;
    else if (k === 'small') small += d;
    else if (k === 'unknown') unknown += d;
    else normal += d;
  }

  const total = big + small + unknown + normal || distance || 1;
  const minutes = duration / 60;
  const km = distance / 1000;
  const bigPct = big / total;
  const smallPct = (small + unknown * 0.5) / total;

  const kmh = minutes > 0 ? km / (minutes / 60) : 0;
  const timeS = clamp(((kmh - 12) / (26 - 12)) * 70 + 30);
  const turnS = clamp(100 - left * 8 + right * 4);
  const roadS = clamp(bigPct * 100 - smallPct * 60);

  const w = normalize(weights);

  const parts: Part[] = [
    { label: `时间 ${timeS.toFixed(0)}分 · 均速${kmh.toFixed(1)}km/h`, value: w.time * timeS },
    { label: `转向 ${turnS.toFixed(0)}分 · 左${left}右${right}`, value: w.turn * turnS },
    { label: `道路 ${roadS.toFixed(0)}分 · 大路${Math.round(bigPct * 100)}%`, value: w.road * roadS },
  ];

  const score = parts.reduce((a, p) => a + p.value, 0);

  return {
    minutes, km, left, right, bigPct, smallPct, kmh,
    timeS, turnS, roadS, parts,
    wNorm: w,
    score,
    grade: grade(score),
  };
}

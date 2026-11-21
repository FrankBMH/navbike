import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { analyze, DEFAULT_WEIGHTS, normalize, Weights } from './src/score';
import AddrInput from './src/AddrInput';
import Nav from './src/Nav';
import {
  loadHistory, saveRecord, removeRecord, loadFavs, saveFav, removeFav,
  loadWeights, saveWeights,
  Saved, Fav,
} from './src/store';

import { getKey, loadKey, maskKey } from './src/config';
import KeyGate from './src/KeyGate';

const RETRY = 3;
const RETRY_WAIT = 1200;
const GAP = 600;

type P = { latitude: number; longitude: number };
type Via = { name: string; location: string };
type Raw = { steps: any[]; distance: number; duration: number };
type Route = { coords: P[]; marks: P[]; legs: number; raw: Raw };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function amapGet(url: string, retries = RETRY): Promise<any> {
  const json = await (await fetch(url)).json();
  if (json.infocode === '10021' && retries > 0) {
    await sleep(RETRY_WAIT);
    return amapGet(url, retries - 1);
  }
  return json;
}

function parsePolyline(s: string): P[] {
  if (!s || typeof s !== 'string') return [];
  return s
    .split(';')
    .map(kv => {
      const [lng, lat] = kv.split(',').map(Number);
      return { latitude: lat, longitude: lng };
    })
    .filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
}

function toPoint(s: string): P {
  const [lng, lat] = s.split(',').map(Number);
  return { latitude: lat, longitude: lng };
}

function ScoreCard({ title, color, res, other }: { title: string; color: string; res: any; other?: any | null }) {
  const r = res;
  const diff = other ? r.score - other.score : null;
  return (
    <View style={[styles.card, { borderLeftColor: color }]}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={[styles.cardScore, { color }]}>{r.score.toFixed(0)}</Text>
        <Text style={styles.cardGrade}>{r.grade}</Text>
      </View>
      {diff !== null && (
        <Text style={[styles.diff, { color: diff >= 0 ? '#0F6E56' : '#A32D2D' }]}>
          {diff >= 0 ? `高 ${diff.toFixed(1)} 分` : `低 ${Math.abs(diff).toFixed(1)} 分`}
        </Text>
      )}
      {r.parts.map((p: any, i: number) => (
        <Text key={i} style={styles.part}>{p.label}　{p.value.toFixed(1)}</Text>
      ))}
    </View>
  );
}

export default function App() {
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const [fromPt, setFromPt] = useState('');
  const [toPt, setToPt] = useState('');

  const [viaText, setViaText] = useState('');
  const [viaPts, setViaPts] = useState<Via[]>([]);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');
  const [resolved, setResolved] = useState<string[]>([]);
  const [a, setA] = useState<Route | null>(null);
  const [b, setB] = useState<Route | null>(null);

  const [history, setHistory] = useState<Saved[]>([]);
  const [favs, setFavs] = useState<Fav[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const [pinTarget, setPinTarget] = useState<Saved | null>(null);
  const [favName, setFavName] = useState('');

  const [w, setW] = useState<Weights>(DEFAULT_WEIGHTS);
  const [wLoaded, setWLoaded] = useState(false);
  const [showW, setShowW] = useState(false);

  const [navOn, setNavOn] = useState(false);

  // 密钥：loading 时不渲染界面（避免闪一下配置页），need 时全屏要求填写
  const [keyState, setKeyState] = useState<'loading' | 'need' | 'ok'>('loading');
  const [editKey, setEditKey] = useState(false);

  useEffect(() => {
    loadHistory().then(setHistory);
    loadFavs().then(setFavs);
    loadKey().then(k => setKeyState(k ? 'ok' : 'need'));
  }, []);

  useEffect(() => {
    loadWeights().then(x => {
      if (x) setW(x);
      setWLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (wLoaded) saveWeights(w);
  }, [w, wLoaded]);

  function changeW(k: keyof Weights, d: number) {
    setW(prev => {
      const next = { ...prev, [k]: Math.min(1, Math.max(0, Number((prev[k] + d).toFixed(2)))) };
      if (next.time + next.turn + next.road < 0.05) return prev;
      return next;
    });
  }

  async function geocode(addr: string) {
    const u = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(addr)}&key=${getKey()}`;
    const j = await amapGet(u);
    if (String(j.status) !== '1' || !j.geocodes?.length) {
      throw new Error(`定位不到「${addr}」，试试加上城市或区名，如「杭州 西湖」`);
    }
    return j.geocodes[0].location as string;
  }

  async function regeo(loc: string) {
    try {
      const u = `https://restapi.amap.com/v3/geocode/regeo?location=${loc}&key=${getKey()}`;
      const j = await amapGet(u);
      return j?.regeocode?.formatted_address ?? '';
    } catch {
      return '';
    }
  }

  async function legRoute(o: string, d: string) {
    const url = `https://restapi.amap.com/v5/direction/electrobike?origin=${o}&destination=${d}&show_fields=cost,navi,polyline&key=${getKey()}`;
    const json = await amapGet(url);
    if (String(json.status) !== '1') throw new Error(`${json.info} (${json.infocode})`);

    const paths = json.route?.paths;
    if (!paths || !paths.length) {
      throw new Error('这两点之间高德给不出电动车路线（跨城、跨海或被禁行区隔断）');
    }

    const path = paths[0];
    const steps: any[] = path.steps || [];
    const duration = Number(path.duration) || steps.reduce((s, x) => s + Number(x.cost?.duration ?? 0), 0);
    return { steps, distance: Number(path.distance), duration };
  }

  async function plan(points: string[]): Promise<Route> {
    let stepsAll: any[] = [];
    let distance = 0;
    let duration = 0;

    for (let i = 0; i < points.length - 1; i++) {
      if (i > 0) await sleep(GAP);
      try {
        const r = await legRoute(points[i], points[i + 1]);
        stepsAll = stepsAll.concat(r.steps);
        distance += r.distance;
        duration += r.duration;
      } catch (e: any) {
        throw new Error(`第 ${i + 1} 段算路失败：${e.message}`);
      }
    }

    return {
      coords: stepsAll.flatMap(s => parsePolyline(s.polyline)),
      marks: points.map(toPoint),
      legs: points.length - 1,
      raw: { steps: stepsAll, distance, duration },
    };
  }

  async function resolveEnds() {
    if (!fromText.trim() || !toText.trim()) throw new Error('起点和终点都要填');
    if (viaText.trim()) throw new Error('中间点还没选定，请从候选里点一条，或清空输入框');

    const o = fromPt || (await geocode(fromText));
    await sleep(GAP);
    const d = toPt || (await geocode(toText));
    return { o, d };
  }

  async function runSingle() {
    setLoading(true); setErr(''); setFlash(''); setA(null); setB(null); setResolved([]);
    try {
      const { o, d } = await resolveEnds();
      const r = await plan([o, ...viaPts.map(v => v.location), d]);
      setA(r);
      await sleep(GAP);
      const r1 = await regeo(o);
      await sleep(GAP);
      const r2 = await regeo(d);
      setResolved([r1, r2]);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runCompare() {
    if (viaPts.length === 0) {
      setErr('对比需要至少一个中间点：那是你的走法，另一条是高德默认');
      return;
    }
    setLoading(true); setErr(''); setFlash(''); setA(null); setB(null); setResolved([]);
    try {
      const { o, d } = await resolveEnds();
      const direct = await plan([o, d]);
      setA(direct);
      await sleep(GAP);
      const mine = await plan([o, ...viaPts.map(v => v.location), d]);
      setB(mine);
      await sleep(GAP);
      const r1 = await regeo(o);
      await sleep(GAP);
      const r2 = await regeo(d);
      setResolved([r1, r2]);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runFav(f: Fav) {
    setFromText(f.from.name);
    setFromPt(f.from.location);
    setToText(f.to.name);
    setToPt(f.to.location);
    setViaPts(f.vias || []);
    setViaText('');
    setShowHistory(false);
    setLoading(true); setErr(''); setFlash(`正在算「${f.name}」…`); setA(null); setB(null); setResolved([]);
    try {
      const pts = [f.from.location, ...(f.vias || []).map(v => v.location), f.to.location];
      const r = await plan(pts);
      setA(r);
      await sleep(GAP);
      const r1 = await regeo(f.from.location);
      await sleep(GAP);
      const r2 = await regeo(f.to.location);
      setResolved([r1, r2]);
      setFlash('');
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setFlash('');
    } finally {
      setLoading(false);
    }
  }

  async function saveCurrent() {
    if (!a) return;
    const m = a.marks;
    const fromLoc = `${m[0].longitude},${m[0].latitude}`;
    const toLoc = `${m[m.length - 1].longitude},${m[m.length - 1].latitude}`;

    const sA = analyze(a.raw.steps, a.raw.distance, a.raw.duration, w);
    const sB = b ? analyze(b.raw.steps, b.raw.distance, b.raw.duration, w) : null;

    const rec: Saved = {
      id: String(Date.now()),
      at: Date.now(),
      from: { name: fromText, location: fromLoc },
      to: { name: toText, location: toLoc },
      vias: viaPts,
      scoreA: sA.score,
      gradeA: sA.grade,
      kmA: sA.km,
      minA: sA.minutes,
      scoreB: sB?.score,
      gradeB: sB?.grade,
    };

    const next = await saveRecord(rec);
    setHistory(next);
    setFlash(`已保存 ${next.length} 条 · 在历史里点 ★ 可设为常用`);
  }

  async function doDel(id: string) {
    const next = await removeRecord(id);
    setHistory(next);
    if (pinTarget?.id === id) setPinTarget(null);
  }

  function del(r: Saved) {
    Alert.alert(
      '删除这条记录？',
      `${r.from.name} → ${r.to.name}`,
      [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => { doDel(r.id); } },
      ],
    );
  }

  function recall(r: Saved) {
    setFromText(r.from.name);
    setFromPt(r.from.location);
    setToText(r.to.name);
    setToPt(r.to.location);
    setViaPts(r.vias || []);
    setShowHistory(false);
    setFlash('已载入，点「算路线」重新计算');
  }

  function openPin(r: Saved) {
    setPinTarget(pinTarget?.id === r.id ? null : r);
    setFavName(r.to.name);
  }

  async function confirmPin(r: Saved) {
    const name = favName.trim() || r.to.name;
    const next = await saveFav({
      id: String(Date.now()),
      name,
      from: r.from,
      to: r.to,
      vias: r.vias || [],
    });
    setFavs(next);
    setPinTarget(null);
    setFavName('');
    setFlash(`「${name}」已置顶，以后点一下就出结果`);
  }

  async function delFav(id: string) {
    const next = await removeFav(id);
    setFavs(next);
    setFlash('已移除常用');
  }

  // ---- 密钥门禁：没有 Key 就全屏拦住，不让进主界面 ----
  if (keyState === 'loading') {
    return (
      <View style={styles.root}>
        <StatusBar style="dark" />
      </View>
    );
  }
  if (keyState === 'need' || editKey) {
    return (
      <View style={styles.root}>
        <StatusBar style="dark" />
        <KeyGate
          onDone={() => {
            setEditKey(false);
            setKeyState('ok');
          }}
          onCancel={editKey ? () => setEditKey(false) : undefined}
        />
      </View>
    );
  }

  // ---- 导航模式：整屏交给 Nav 组件 ----
  if (navOn && a) {
    const destPt = a.marks[a.marks.length - 1];
    return (
      <Nav
        steps={a.raw.steps}
        marks={a.marks}
        destName={toText || '终点'}
        onExit={() => setNavOn(false)}
        planFrom={async (loc, vias) => {
          // 中间点用「分段算路」拼：当前位置 → 中间点1 → 中间点2 → 终点
          const pts = [loc, ...(vias || []).map(v => `${v.longitude},${v.latitude}`), `${destPt.longitude},${destPt.latitude}`];
          const r = await plan(pts);
          setA(r);
          return r.raw.steps;
        }}
      />
    );
  }

  const shown = [...(a?.coords ?? []), ...(b?.coords ?? [])];
  const region = shown.length
    ? (() => {
        const lats = shown.map(c => c.latitude);
        const lngs = shown.map(c => c.longitude);
        const minLat = Math.min(...lats), maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
        return {
          latitude: (minLat + maxLat) / 2,
          longitude: (minLng + maxLng) / 2,
          latitudeDelta: Math.max((maxLat - minLat) * 1.4, 0.005),
          longitudeDelta: Math.max((maxLng - minLng) * 1.4, 0.005),
        };
      })()
    : null;

  const markerSrc = (b ?? a)?.marks ?? [];

  const resA = a ? analyze(a.raw.steps, a.raw.distance, a.raw.duration, w) : null;
  const resB = b ? analyze(b.raw.steps, b.raw.distance, b.raw.duration, w) : null;
  const wNorm = normalize(w);

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />

      {favs.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.favRow}
          contentContainerStyle={{ alignItems: 'center' }}
        >
          {favs.map(f => (
            <Pressable
              key={f.id}
              style={styles.fav}
              onPress={() => runFav(f)}
              onLongPress={() => delFav(f.id)}
            >
              <Text style={styles.favText}>{f.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <AddrInput
        value={fromText}
        onChangeText={t => { setFromText(t); setFromPt(''); }}
        onPick={p => { setFromText(p.name); setFromPt(p.location); }}
        placeholder="起点"
        apiKey={getKey()}
      />

      <AddrInput
        value={toText}
        onChangeText={t => { setToText(t); setToPt(''); }}
        onPick={p => { setToText(p.name); setToPt(p.location); }}
        placeholder="终点"
        apiKey={getKey()}
      />

      <AddrInput
        value={viaText}
        onChangeText={setViaText}
        onPick={p => { setViaPts([...viaPts, { name: p.name, location: p.location }]); setViaText(''); }}
        placeholder="加中间点（对比时必填）"
        apiKey={getKey()}
      />

      {viaPts.length > 0 && (
        <View style={styles.chips}>
          {viaPts.map((v, i) => (
            <Pressable
              key={`${v.location}-${i}`}
              style={styles.chip}
              onPress={() => setViaPts(viaPts.filter((_, j) => j !== i))}
            >
              <Text style={styles.chipText}>{i + 1}. {v.name}　✕</Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.row}>
        <Pressable style={[styles.btn, { flex: 1 }]} onPress={runSingle} disabled={loading}>
          <Text style={styles.btnText}>{loading ? '算路中…' : '算路线'}</Text>
        </Pressable>
        <Pressable style={[styles.btnAlt, { flex: 1 }]} onPress={runCompare} disabled={loading}>
          <Text style={styles.btnAltText}>对比我的走法</Text>
        </Pressable>
      </View>

      <View style={styles.rowTiny}>
        <Pressable onPress={saveCurrent} disabled={!a}>
          <Text style={[styles.link, { color: a ? '#185FA5' : '#bbb' }]}>保存结果</Text>
        </Pressable>
        <Pressable onPress={() => setShowW(v => !v)}>
          <Text style={[styles.link, { color: showW ? '#993C1D' : '#185FA5' }]}>
            调权重 {Math.round(wNorm.time * 100)}/{Math.round(wNorm.turn * 100)}/{Math.round(wNorm.road * 100)}
          </Text>
        </Pressable>
        <Pressable onPress={() => { setShowHistory(v => !v); setPinTarget(null); }}>
          <Text style={styles.link}>{showHistory ? '收起历史' : `历史 ${history.length}`}</Text>
        </Pressable>
      </View>

      <View style={styles.keyRow}>
        <Text style={styles.keyHint}>高德 Key {maskKey(getKey())}</Text>
        <Pressable onPress={() => setEditKey(true)} hitSlop={10}>
          <Text style={styles.link}>修改</Text>
        </Pressable>
      </View>

      {a && !showHistory && (
        <Pressable style={styles.btnNav} onPress={() => setNavOn(true)}>
          <Text style={styles.btnNavText}>
            ▶ 开始导航　{resA ? `${resA.km.toFixed(1)} km · ${resA.minutes.toFixed(0)} 分钟` : ''}
          </Text>
        </Pressable>
      )}

      {showW && (
        <View style={styles.wPanel}>
          {(['time', 'turn', 'road'] as const).map(k => {
            const label = k === 'time' ? '时间' : k === 'turn' ? '转向' : '道路';
            const pct = Math.round(wNorm[k] * 100);
            return (
              <View key={k} style={styles.wRow}>
                <Text style={styles.wLabel}>{label}</Text>
                <Pressable style={styles.wBtn} onPress={() => changeW(k, -0.05)}>
                  <Text style={styles.wBtnText}>−</Text>
                </Pressable>
                <View style={styles.wBarWrap}>
                  <View style={[styles.wBar, { flex: Math.max(0.5, pct) }]} />
                  <View style={{ flex: Math.max(0.5, 100 - pct) }} />
                </View>
                <Text style={styles.wVal}>{pct}%</Text>
                <Pressable style={styles.wBtn} onPress={() => changeW(k, 0.05)}>
                  <Text style={styles.wBtnText}>＋</Text>
                </Pressable>
              </View>
            );
          })}
          <View style={styles.wFoot}>
            <Pressable onPress={() => setW(DEFAULT_WEIGHTS)}>
              <Text style={styles.link}>恢复默认 45/35/20</Text>
            </Pressable>
            <Text style={styles.wHint}>改完立即生效，无需重算</Text>
          </View>
        </View>
      )}

      {!!err && <Text style={styles.err}>{err}</Text>}
      {!!flash && <Text style={styles.flash}>{flash}</Text>}
      {loading && <ActivityIndicator style={{ marginTop: 8 }} />}

      {resolved.length === 2 && !showHistory && (
        <Text style={styles.addr}>{resolved[0]}　→　{resolved[1]}</Text>
      )}

      {!showHistory && resA && <ScoreCard title={b ? '高德默认' : '本次路线'} color="#185FA5" res={resA} other={resB} />}
      {!showHistory && resB && <ScoreCard title="我的走法" color="#D85A30" res={resB} other={resA} />}

      {showHistory ? (
        <ScrollView style={styles.list}>
          {history.length === 0 && <Text style={styles.empty}>还没有记录，算完一条路点「保存结果」</Text>}
          {history.map(r => (
            <View key={r.id}>
              <View style={styles.item}>
                <Pressable style={styles.itemMain} onPress={() => recall(r)}>
                  <Text style={styles.itemTitle} numberOfLines={1}>
                    {r.from.name} → {r.to.name}
                    {r.vias?.length ? `（经 ${r.vias.length} 点）` : ''}
                  </Text>
                  <Text style={styles.itemSub}>
                    {new Date(r.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    　{r.minA.toFixed(0)} 分钟 · {r.kmA.toFixed(1)} km
                    　{r.scoreA.toFixed(0)} 分{r.scoreB ? ` / 我的 ${r.scoreB.toFixed(0)} 分` : ''}
                  </Text>
                </Pressable>
                <Pressable style={styles.iconBtn} onPress={() => openPin(r)}>
                  <Text style={styles.star}>★</Text>
                </Pressable>
                <Pressable style={styles.iconBtn} onPress={() => del(r)}>
                  <Text style={styles.del}>✕</Text>
                </Pressable>
              </View>

              {pinTarget?.id === r.id && (
                <View style={styles.pinBox}>
                  <TextInput
                    style={styles.pinInput}
                    value={favName}
                    onChangeText={setFavName}
                    placeholder="起个名字，如 上班 / 回家"
                    autoFocus
                  />
                  <Pressable style={styles.pinOk} onPress={() => confirmPin(r)}>
                    <Text style={styles.pinOkText}>置顶</Text>
                  </Pressable>
                </View>
              )}
            </View>
          ))}
        </ScrollView>
      ) : (
        region && (
          <MapView style={styles.map} initialRegion={region}>
            {a && <Polyline coordinates={a.coords} strokeColor="#185FA5" strokeWidth={5} />}
            {b && <Polyline coordinates={b.coords} strokeColor="#D85A30" strokeWidth={5} />}
            {markerSrc.map((m, i) => (
              <Marker
                key={i}
                coordinate={m}
                title={i === 0 ? '起点' : i === markerSrc.length - 1 ? '终点' : `中间点 ${i}`}
                pinColor={i === 0 ? 'green' : i === markerSrc.length - 1 ? 'red' : 'orange'}
              />
            ))}
          </MapView>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff', paddingTop: 52, paddingHorizontal: 16 },
  favRow: { maxHeight: 42, marginBottom: 8 },
  fav: { backgroundColor: '#E8F0F8', borderRadius: 16, paddingVertical: 8, paddingHorizontal: 14, marginRight: 8 },
  favText: { fontSize: 14, color: '#185FA5', fontWeight: '500' },
  row: { flexDirection: 'row', marginTop: 6 },
  btn: { backgroundColor: '#185FA5', paddingVertical: 13, borderRadius: 10, alignItems: 'center', marginRight: 6 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '500' },
  btnAlt: { backgroundColor: '#FAECE7', paddingVertical: 13, borderRadius: 10, alignItems: 'center', marginLeft: 6 },
  btnAltText: { color: '#993C1D', fontSize: 15, fontWeight: '500' },
  rowTiny: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
  btnNav: { backgroundColor: '#0F6E56', paddingVertical: 13, borderRadius: 10, alignItems: 'center', marginTop: 12 },
  btnNavText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  link: { fontSize: 13, color: '#185FA5' },
  keyRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: 8 },
  keyHint: { fontSize: 11, color: '#a8a8a0', marginRight: 10 },
  wPanel: { marginTop: 8, padding: 10, backgroundColor: '#FAF9F6', borderRadius: 10, borderWidth: 1, borderColor: '#F0EBE0' },
  wRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  wLabel: { width: 34, fontSize: 13, color: '#555' },
  wBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#EFEFEA', alignItems: 'center', justifyContent: 'center' },
  wBtnText: { fontSize: 15, color: '#333', lineHeight: 18 },
  wBarWrap: { flex: 1, flexDirection: 'row', height: 6, backgroundColor: '#E8E8E2', borderRadius: 3, marginHorizontal: 10, overflow: 'hidden' },
  wBar: { height: 6, backgroundColor: '#185FA5', borderRadius: 3 },
  wVal: { width: 38, fontSize: 12, color: '#333', textAlign: 'right' },
  wFoot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  wHint: { fontSize: 11, color: '#999' },
  chip: { backgroundColor: '#FAEEDA', borderRadius: 14, paddingVertical: 6, paddingHorizontal: 12, marginRight: 8, marginBottom: 6 },
  chipText: { fontSize: 13, color: '#854F0B' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 2 },
  err: { color: '#A32D2D', marginTop: 8, lineHeight: 19, fontSize: 13 },
  flash: { color: '#0F6E56', marginTop: 8, fontSize: 13 },
  addr: { fontSize: 12, color: '#666', marginTop: 8, lineHeight: 17 },
  card: { marginTop: 8, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: '#FAFAF8', borderRadius: 8, borderLeftWidth: 4 },
  cardHead: { flexDirection: 'row', alignItems: 'baseline' },
  cardTitle: { fontSize: 13, color: '#555', marginRight: 8 },
  cardScore: { fontSize: 22, fontWeight: '500' },
  cardGrade: { fontSize: 12, color: '#888', marginLeft: 6 },
  diff: { fontSize: 12, marginBottom: 2 },
  part: { fontSize: 12, color: '#666', lineHeight: 17 },
  map: { flex: 1, marginTop: 8, marginBottom: 8, borderRadius: 12, overflow: 'hidden' },
  list: { flex: 1, marginTop: 8 },
  item: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  itemMain: { flex: 1, paddingVertical: 10 },
  itemTitle: { fontSize: 14, color: '#111' },
  itemSub: { fontSize: 12, color: '#888', marginTop: 2 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  star: { fontSize: 18, color: '#D8A020' },
  del: { fontSize: 16, color: '#bbb' },
  empty: { fontSize: 13, color: '#999', marginTop: 20, textAlign: 'center' },
  pinBox: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, backgroundColor: '#FAFAF8', borderRadius: 8, paddingHorizontal: 8, marginBottom: 6 },
  pinInput: { flex: 1, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, backgroundColor: '#fff' },
  pinOk: { backgroundColor: '#185FA5', borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14, marginLeft: 8 },
  pinOkText: { color: '#fff', fontSize: 13, fontWeight: '500' },
});

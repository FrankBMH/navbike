import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polygon, Polyline, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import { useKeepAwake } from 'expo-keep-awake';
import { buildGuide, dist, fmtDist, Guide, nearest, nearestAll, P } from './guide';

type Props = {
  steps: any[];
  marks: P[];
  destName: string;
  onExit: () => void;
  // 重新规划：从当前位置出发，仍要经过还没过的中间点
  planFrom: (location: string, vias: P[]) => Promise<any[]>;
};

const TH = [300, 100, 30]; // 播报档位（米）
const ON_ROUTE = 60; // 离路线多近算「已上路」
const ADV_ON_ROUTE = 60; // 只有贴着路线，才把这段算成「已走过」
const ADV_MAX = 200; // 单次定位最多前进 200 米，防止 GPS 漂移把进度一下推出去
const GESTURE_PAUSE = 2000; // 手指动过地图后，镜头让开多久（毫秒）

type Phase = 'toStart' | 'on' | 'done';

const M_PER_DEG_LAT = 111320;

/** 从一个点沿 bearing 方向走 meters 米后的坐标（近距离近似，够画箭头用） */
function offset(p: P, bearingDeg: number, meters: number): P {
  const r = (bearingDeg * Math.PI) / 180;
  const dLat = (meters * Math.cos(r)) / M_PER_DEG_LAT;
  const dLon = (meters * Math.sin(r)) / (M_PER_DEG_LAT * Math.cos((p.latitude * Math.PI) / 180));
  return { latitude: p.latitude + dLat, longitude: p.longitude + dLon };
}

/** 箭头三角：真正画在地图坐标里，所以跟着地图缩放、旋转，不会被“放大” */
function arrowTriangle(p: P, heading: number, zoom: number): P[] {
  // 当前缩放级别下 1 像素约等于多少米
  const mpp = (156543.03392 * Math.cos((p.latitude * Math.PI) / 180)) / Math.pow(2, zoom);
  const tip = Math.max(6, 17 * mpp); // 箭头长（米），跟着缩放保持屏幕上大小不变
  const back = tip * 0.78;
  return [offset(p, heading, tip), offset(p, heading - 145, back), offset(p, heading + 145, back)];
}


export default function Nav({ steps, marks, destName, onExit, planFrom }: Props) {
  useKeepAwake();

  const [raw, setRaw] = useState<any[]>(steps);
  const guide: Guide = useMemo(() => buildGuide(raw), [raw]);
  const gRef = useRef<Guide>(guide);
  gRef.current = guide;

  const [idx, setIdx] = useState(0);
  const [dev, setDev] = useState(0); // 离路线多远
  const [dStart, setDStart] = useState(0); // 离起点多远
  const [pos, setPos] = useState<P | null>(null);
  const [speed, setSpeed] = useState(0);
  const [head, setHead] = useState(0); // 面向（0=北，顺时针）
  const [phase, setPhase] = useState<Phase>('toStart');
  const [off, setOff] = useState(false);
  const [voice, setVoice] = useState(true);
  const [course, setCourse] = useState(true); // true=车头向上，false=北向上
  const [err, setErr] = useState('');
  const [rerouting, setRerouting] = useState(false);

  const mapRef = useRef<MapView>(null);
  const spoken = useRef<Set<string>>(new Set());
  const offCount = useRef(0);
  const idxRef = useRef(0);
  const phaseRef = useRef<Phase>('toStart');
  const headRef = useRef(0); // 罗盘 / GPS 朝向
  const camHead = useRef(0); // 平滑后的镜头朝向
  const lastFix = useRef<{ p: P; t: number } | null>(null);
  const lastCam = useRef(0);
  const zoomRef = useRef(18); // 当前缩放级别，跟随镜头用它，不写死
  const lastGesture = useRef(0); // 最近一次手动操作地图的时间，这段时间内镜头让开
  const lastTurn = useRef(0); // 罗盘转镜头的节流
  const posRef = useRef<P | null>(null); // 最新定位点，罗盘回调里也能用
  const zoomDeltaRef = useRef(0); // 当前可视范围，用来判断「这是缩放还是拖动」
  const lastHeadUi = useRef(0); // 罗盘刷新节流
  const doneRef = useRef(false);
  const offRef = useRef(false);
  const courseRef = useRef(true);
  const voiceRef = useRef(true);
  courseRef.current = course;
  voiceRef.current = voice;

  function goPhase(p: Phase) {
    phaseRef.current = p;
    setPhase(p);
  }

  function speak(text: string) {
    if (!voiceRef.current) return;
    Speech.stop();
    Speech.speak(text, { language: 'zh-CN', rate: 1.0 });
  }

  function announce(key: string, text: string) {
    if (spoken.current.has(key)) return;
    spoken.current.add(key);
    speak(text);
  }

  /** 镜头：车头向上就按朝向转，北向上就不转 */
  function follow(p: P, force = false) {
    const now = Date.now();
    // 你正在用手指摆弄地图，这几秒内完全不动镜头，否则刚捏好就被拽回去
    if (!force && now - lastGesture.current < GESTURE_PAUSE) return;
    if (!force && now - lastCam.current < 700) return;
    lastCam.current = now;

    if (courseRef.current) {
      if (force) {
        camHead.current = headRef.current; // 切模式/刚上路：直接对正，别慢慢转
      } else {
        // 359°→1° 直接插值会甩一圈，按最短弧走
        const d = ((headRef.current - camHead.current + 540) % 360) - 180;
        camHead.current = (camHead.current + d * 0.5 + 360) % 360;
      }
    } else {
      camHead.current = 0;
    }

    mapRef.current?.animateCamera(
      {
        center: p,
        heading: camHead.current,
        pitch: courseRef.current ? 50 : 0,
        zoom: zoomRef.current,
      },
      { duration: 700 },
    );
  }

  /**
   * 只转镜头：罗盘一变化就调它。
   * 关键点——以前只有「收到新定位」时才动镜头，可 iOS 站着不动不发新定位
   * （distanceFilter=1 米），所以原地转手机地图纹丝不动。
   */
  function turnCamera() {
    const p = posRef.current;
    if (!p) return;
    if (!courseRef.current) return; // 北向上：地图本来就不该转
    if (phaseRef.current !== 'on') return; // 还没上路时看的是全程全览，别转
    const now = Date.now();
    if (now - lastGesture.current < GESTURE_PAUSE) return; // 你正在摆弄地图
    if (now - lastTurn.current < 250) return; // 节流，别把地图拧成陀螺
    lastTurn.current = now;
    lastCam.current = now; // 自己转的不算「手势」

    // 最短弧插值，0.6 是跟手速度（太大抖、太小肉）
    const d = ((headRef.current - camHead.current + 540) % 360) - 180;
    camHead.current = (camHead.current + d * 0.6 + 360) % 360;

    mapRef.current?.animateCamera(
      { center: p, heading: camHead.current, pitch: 50, zoom: zoomRef.current },
      { duration: 300 },
    );
  }

  /**
   * 手指捏合结束后，把「你现在看到的缩放级别」记下来，换算成 zoomRef。
   * 只换算一次、之后一直用这个值，所以不会有来回推导致的抖动。
   * 俯视 50° 时同样 zoom 看到的地面更宽，会让换算值偏小，加个补偿。
   */
  /**
   * 手指一碰地图就开始让开（这个事件是连续的，不是松手才来）。
   * 拖着地图的时候，如果镜头还在每秒回中，你会觉得「拖不动」——就是它干的。
   */
  function onRegionChange(_r: Region, d?: { isGesture?: boolean }) {
    if (d && d.isGesture === false) return; // 是我们自己动的地图，不算
    if (Date.now() - lastCam.current < 900) return; // 刚发起的跟随动画，也不算
    lastGesture.current = Date.now();
  }

  /** 手指按在屏幕上：不管地图认不认成手势，镜头先停手 */
  function onTouch() {
    lastGesture.current = Date.now();
  }

  /**
   * 手指操作结束后：记下「你动过地图」，3 秒内镜头别抢。
   * 只有可视范围真的变了（捏合），才重算缩放级别；
   * 单纯拖动时范围也会轻微变化（俯视角的关系），那种不算缩放，别把地图带跑。
   */
  function onRegionDone(r: Region, d: { isGesture?: boolean }) {
    const prev = zoomDeltaRef.current;
    const ratio = prev > 0 ? r.longitudeDelta / prev : 0;

    if (d?.isGesture) {
      lastGesture.current = Date.now();
      if (ratio > 0 && Math.abs(ratio - 1) > 0.12) {
        const raw = Math.log2(360 / Math.max(r.longitudeDelta, 1e-9));
        if (Number.isFinite(raw)) {
          const z = raw + (courseRef.current ? 0.9 : 0); // 俯视时视窗更宽，补一点
          // 单次手势最多认 2.5 级，避免异常 region 把缩放带飞
          zoomRef.current = Math.max(
            14.5,
            Math.min(20, Math.min(zoomRef.current + 2.5, Math.max(zoomRef.current - 2.5, z))),
          );
        }
      }
    }

    zoomDeltaRef.current = r.longitudeDelta;
  }

  function onPos(loc: Location.LocationObject) {
    const g = gRef.current;
    if (!g.pts.length) return;

    const p: P = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
    posRef.current = p;
    setPos(p);
    setDStart(dist(p, g.pts[0]));

    let sp: number | null = loc.coords.speed;
    if (sp == null || !Number.isFinite(sp) || sp < 0) {
      const lf = lastFix.current;
      if (lf) {
        const dt = (loc.timestamp - lf.t) / 1000;
        if (dt > 0.3) sp = dist(lf.p, p) / dt;
      }
    }
    const mps = sp != null && Number.isFinite(sp) && sp >= 0 ? sp : 0;
    setSpeed(mps * 3.6);
    lastFix.current = { p, t: loc.timestamp };

    // 朝向：骑起来（>2.5m/s）用 GPS 航向更准；慢下来/停着用罗盘
    const gh = loc.coords.heading;
    if (mps > 2.5 && gh != null && Number.isFinite(gh) && gh >= 0) headRef.current = gh;
    setHead(headRef.current);

    const near = nearest(g, p, idxRef.current);
    /**
     * 进度只「往前走」是对的，但绝不能让一次定位把进度甩出去几公里。
     * 以前是 `idx = near.idx`，一旦人不在线附近（还没上路、GPS 飘了），
     * 全局最近点可能落在路线后段，于是整段路一下全变成「已走过」的灰色 —— 就是你看到的那条「加粗却没蓝色」。
     * 现在：只有贴着路线（60 米内）才累计，且单次最多前进 200 米。
     */
    if (near.off <= ADV_ON_ROUTE && near.idx > idxRef.current) {
      const fromCum = g.cum[idxRef.current] ?? 0;
      let next = idxRef.current;
      while (next < near.idx && (g.cum[next + 1] ?? fromCum) - fromCum <= ADV_MAX) next++;
      idxRef.current = next;
    }
    setIdx(idxRef.current);
    setDev(near.off);

    // 贴到路线上才进入跟随模式
    if (phaseRef.current === 'toStart' && near.off <= ON_ROUTE) {
      goPhase('on');
      lastGesture.current = 0; // 上路了，立刻开始跟随，别被刚才的手势暂停挡住
      follow(p, true); // 直接切到「车头向上 + 俯视」，别等下一秒
      speak('已上路，开始导航');
    }

    // 偏航
    offCount.current = near.off > 60 ? offCount.current + 1 : 0;
    if (phaseRef.current === 'on') {
      if (offCount.current >= 3) {
        if (!offRef.current) {
          offRef.current = true;
          setOff(true);
        }
        announce('offroute', '你已偏离路线');
      } else if (near.off < 30 && offRef.current) {
        offRef.current = false;
        setOff(false);
        spoken.current.delete('offroute');
      }
    }

    if (phaseRef.current !== 'on' || doneRef.current) return;

    const here = g.cum[idxRef.current] ?? 0;
    const remain = g.total - here;

    if (remain < 25) {
      doneRef.current = true;
      goPhase('done');
      speak('已到达目的地，导航结束');
      return;
    }

    const si = g.stepOf[Math.min(idxRef.current, g.pts.length - 1)] ?? 0;
    const m = g.man[si];
    if (m) {
      const to = m.cum - here;
      const hit = TH.find(t => to <= t); // 只播当前最该播的那一档
      if (hit != null) {
        const key = `${si}-${hit}`;
        if (!spoken.current.has(key)) {
          TH.filter(t => t >= hit).forEach(t => spoken.current.add(`${si}-${t}`));
          const road = m.road && m.action !== '到达目的地' ? `进入${m.road}` : '';
          speak(hit > 30 ? `前方${fmtDist(to)}${m.action}${road}` : `请${m.action}${road}`);
        }
      }
    }

    follow(p);
  }

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let hsub: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setErr('没拿到定位权限。到 设置 › Expo Go › 位置 里选「使用App时允许」，再重进导航');
          return;
        }
        if (cancelled) return;

        // 罗盘：站着不动也能实时知道朝哪 —— 方向感靠它
        hsub = await Location.watchHeadingAsync(h => {
          const v = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
          if (v >= 0 && h.accuracy >= 1) {
            headRef.current = v;
            const now = Date.now();
            if (now - lastHeadUi.current > 150) {
              lastHeadUi.current = now;
              setHead(v); // 让地图上的箭头跟着转，不用等下一个定位点
            }
            turnCamera(); // 地图也跟着转 —— 这一步以前缺了，所以站着转手机地图不动
          }
        });

        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 1 },
          onPos,
        );
      } catch (e: any) {
        setErr(`定位启动失败：${e?.message ?? String(e)}`);
      }
    })();

    return () => {
      cancelled = true;
      sub?.remove();
      hsub?.remove();
      Speech.stop();
    };
  }, []);

  // 进场：先把全程框进屏幕，让你一眼看到线在哪
  useEffect(() => {
    if (!guide.pts.length) return;
    const t = setTimeout(() => {
      mapRef.current?.fitToCoordinates(guide.pts, {
        edgePadding: { top: 170, right: 50, bottom: 190, left: 50 },
        animated: false,
      });
    }, 600);
    return () => clearTimeout(t);
  }, [guide.pts.length]);

  // 换朝向后立刻重设镜头，不用等下一秒定位
  useEffect(() => {
    lastCam.current = 0;
    if (pos && phaseRef.current === 'on') follow(pos, true);
  }, [course]);

  /**
   * 重新规划：从当前位置出发，但要保住还没过的中间点。
   * 高德的电动车接口一次只能算两点之间，所以中间点是靠「分段算路」拼出来的，
   * 这条链不能断 —— 以前这里只传了起点和终点，中间点就整个丢了。
   */
  async function reroute() {
    if (rerouting) return;
    const p = pos ?? lastFix.current?.p;
    if (!p) return;
    setRerouting(true);
    try {
      const g = gRef.current;
      const passedCum = g.cum[idxRef.current] ?? 0;
      const vias = marks
        .slice(1, -1) // 去掉起点和终点，剩下的是中间点
        .filter(v => {
          const at = nearestAll(g, v);
          // 已经走过的（含身后 30 米内）就不再绕回去
          return (g.cum[at.idx] ?? 0) > passedCum - 30;
        });

      const next = await planFrom(`${p.longitude},${p.latitude}`, vias);
      spoken.current = new Set();
      offCount.current = 0;
      offRef.current = false;
      idxRef.current = 0;
      doneRef.current = false;
      lastCam.current = 0;
      setIdx(0);
      setOff(false);
      setRaw(next);
      goPhase('on');
      speak(vias.length ? `已重新规划，仍会经过 ${vias.length} 个中间点` : '已重新规划路线');
    } catch {
      speak('重新规划失败，请按原路继续');
    } finally {
      setRerouting(false);
    }
  }

  function quit() {
    Alert.alert('结束导航？', '结束后回到路线页面', [
      { text: '继续导航', style: 'cancel' },
      { text: '结束', style: 'destructive', onPress: onExit },
    ]);
  }

  const q = Math.min(Math.floor(idx / 8) * 8, Math.max(0, guide.pts.length - 1));
  const passed = useMemo(() => guide.pts.slice(0, q + 1), [guide, q]);
  const left = useMemo(() => guide.pts.slice(q), [guide, q]);

  const here = guide.cum[idx] ?? 0;
  const remain = Math.max(0, guide.total - here);
  const si = guide.stepOf[Math.min(idx, Math.max(0, guide.pts.length - 1))] ?? 0;
  const m = guide.man[si];
  const toManeuver = m ? Math.max(0, m.cum - here) : 0;

  const baseMin = useMemo(
    () => raw.reduce((s, x) => s + (Number(x.cost?.duration) || 0), 0) / 60,
    [raw],
  );
  const remainMin = guide.total > 0 ? (remain / guide.total) * baseMin : 0;
  const eta = new Date(Date.now() + remainMin * 60000);
  const etaText = `${String(eta.getHours()).padStart(2, '0')}:${String(eta.getMinutes()).padStart(2, '0')}`;

  const first = guide.pts[0] ?? marks[0] ?? { latitude: 30.27, longitude: 120.15 };
  const dest = marks[marks.length - 1] ?? guide.pts[guide.pts.length - 1];
  // 箭头画成地图上的三角形（iOS 上 Marker 的 rotation 根本不被支持，转了也白转）
  const arrowTri = useMemo(() => (pos ? arrowTriangle(pos, head, zoomRef.current) : null), [pos, head]);

  if (err) {
    return (
      <View style={styles.errBox}>
        <Text style={styles.errText}>{err}</Text>
        <Pressable style={styles.errBtn} onPress={onExit}>
          <Text style={styles.errBtnText}>返回</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={StyleSheet.absoluteFill} onTouchStart={onTouch} onTouchMove={onTouch}>
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          initialCamera={{ center: first, heading: 0, pitch: 0, zoom: 15 }}
          showsCompass
          showsUserLocation={phase === 'toStart'}
          showsMyLocationButton={false}
          zoomEnabled
          scrollEnabled
          rotateEnabled={false}
          onPanDrag={onTouch}
          onRegionChange={onRegionChange}
          onRegionChangeComplete={onRegionDone}
          toolbarEnabled={false}
        >
        {/* 先画「已走过」的灰线，再画蓝线盖在上面：重叠处（掉头、折返）永远是蓝色优先 */}
        {passed.length > 1 && <Polyline coordinates={passed} strokeColor="#BDBDB6" strokeWidth={7} />}
        {left.length > 1 && <Polyline coordinates={left} strokeColor="#185FA5" strokeWidth={7} />}

        {/* 你：画在地图坐标里的箭头，缩放/平移/旋转都跟它自己的经纬度走 */}
        {arrowTri && (
          <Polygon
            coordinates={arrowTri}
            strokeColor="#FFFFFF"
            strokeWidth={2}
            fillColor="#185FA5"
            zIndex={99}
          />
        )}
        {marks.slice(0, -1).map((v, i) => (
          <Marker key={`v${i}`} coordinate={v} pinColor="orange" title={`中间点 ${i + 1}`} />
        ))}
        {dest && <Marker coordinate={dest} pinColor="red" title={destName} />}
        </MapView>
      </View>

      <View style={styles.top}>
        <Pressable style={styles.modeBtn} onPress={() => setCourse(v => !v)} hitSlop={8}>
          <Text style={styles.modeText}>{course ? '车↑' : '北↑'}</Text>
        </Pressable>

        {phase === 'toStart' ? (
          <>
            <Text style={styles.action}>还没到路线上</Text>
            <Text style={styles.big}>{fmtDist(Math.max(dev, dStart))}</Text>
            <Text style={styles.sub}>
              蓝色的是全程路线。骑到线上会自动开始导航，也可以直接按下面重算（上路后地图才跟着车头转）
            </Text>
            <Pressable style={styles.planBtn} onPress={reroute} disabled={rerouting}>
              <Text style={styles.planBtnText}>{rerouting ? '规划中…' : '从我现在的位置重新规划'}</Text>
            </Pressable>
          </>
        ) : phase === 'done' ? (
          <>
            <Text style={styles.big}>已到达</Text>
            <Text style={styles.action}>{destName}</Text>
          </>
        ) : (
          <>
            <Text style={styles.action}>
              {m?.action ?? '直行'}
              {m?.road && m.action !== '到达目的地' ? ` · ${m.road}` : ''}
            </Text>
            <Text style={styles.big}>{fmtDist(toManeuver)}</Text>
            <Text style={styles.sub}>
              剩余 {fmtDist(remain)} · {Math.max(1, Math.round(remainMin))} 分钟 · {etaText} 到
            </Text>
          </>
        )}
      </View>

      {off && phase === 'on' && (
        <View style={styles.offBar}>
          <Text style={styles.offText}>已偏离路线（{Math.round(dev)} 米）</Text>
          <Pressable style={styles.offBtn} onPress={reroute} disabled={rerouting}>
            <Text style={styles.offBtnText}>{rerouting ? '规划中…' : '重新规划'}</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.bottom}>
        <View style={styles.stat}>
          <Text style={styles.statVal}>{speed.toFixed(0)}</Text>
          <Text style={styles.statKey}>km/h</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statVal}>{fmtDist(remain)}</Text>
          <Text style={styles.statKey}>剩余</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statVal}>{Math.round(head)}°</Text>
          <Text style={styles.statKey}>朝向</Text>
        </View>

        <View style={styles.miniGroup}>
          <Pressable style={styles.mini} onPress={() => setVoice(v => !v)}>
            <Text style={styles.miniText}>{voice ? '🔊' : '🔇'}</Text>
          </Pressable>
          <Pressable style={styles.mini} onPress={quit}>
            <Text style={styles.miniText}>退出</Text>
          </Pressable>
        </View>
      </View>

      {rerouting && <ActivityIndicator style={styles.spin} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  top: {
    position: 'absolute',
    top: 54,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 16,
    padding: 14,
    paddingRight: 52,
    borderWidth: 1,
    borderColor: '#E6E2D8',
  },
  modeBtn: {
    position: 'absolute',
    top: 10,
    right: 10,
    paddingVertical: 6,
    paddingHorizontal: 9,
    borderRadius: 8,
    backgroundColor: '#F1F0EA',
  },
  modeText: { fontSize: 12, color: '#444' },
  action: { fontSize: 17, color: '#185FA5', fontWeight: '600', marginBottom: 2 },
  big: { fontSize: 40, color: '#111', fontWeight: '700', letterSpacing: -1 },
  sub: { fontSize: 13, color: '#666', marginTop: 4, lineHeight: 19 },
  planBtn: { marginTop: 10, backgroundColor: '#F1F0EA', borderRadius: 9, paddingVertical: 10, alignItems: 'center' },
  planBtnText: { fontSize: 13, color: '#185FA5', fontWeight: '600' },
  offBar: {
    position: 'absolute',
    top: 236,
    left: 12,
    right: 12,
    backgroundColor: '#FBEAE8',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#F0C8C2',
  },
  offText: { fontSize: 13, color: '#A32D2D', flex: 1 },
  offBtn: { backgroundColor: '#A32D2D', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12 },
  offBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  bottom: {
    position: 'absolute',
    bottom: 26,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#E6E2D8',
  },
  stat: { marginRight: 12, minWidth: 42 },
  statVal: { fontSize: 16, color: '#111', fontWeight: '600' },
  statKey: { fontSize: 11, color: '#999' },
  miniGroup: { marginLeft: 'auto', flexDirection: 'row' },
  mini: {
    marginLeft: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#F1F0EA',
  },
  miniText: { fontSize: 13, color: '#333' },
  spin: { position: 'absolute', top: '50%', right: 24 },
  errBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: '#fff' },
  errText: { fontSize: 15, color: '#A32D2D', lineHeight: 23, textAlign: 'center' },
  errBtn: { marginTop: 20, backgroundColor: '#185FA5', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 26 },
  errBtnText: { color: '#fff', fontSize: 15, fontWeight: '500' },
});

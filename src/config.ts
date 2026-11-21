/**
 * 高德 Web 服务 Key —— 存在手机本地，**不写进代码，也不写进安装包**。
 *
 * 为什么这样设计：
 * - Key 一旦被内联进 ipa，任何人拿到安装包都能搜出明文，等于把 Key 送人
 * - 存本地后，换 Key 只要在 App 里改一下，不用重新打包、不用重新签名安装
 *
 * 首次启动时由 keygate 页面引导填写，并联网验证一次。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const K_KEY = 'navbike.amapkey.v1';

/** 内存缓存：所有请求函数都要同步读 Key，不能每次 await */
let cached = '';

/** 启动时调用一次，把本地存的 Key 读进内存 */
export async function loadKey(): Promise<string> {
  try {
    const raw = await AsyncStorage.getItem(K_KEY);
    cached = (raw ?? '').trim();
  } catch {
    cached = '';
  }
  return cached;
}

/** 同步读当前 Key。所有高德请求都用它 */
export function getKey(): string {
  return cached;
}

export function hasKey(): boolean {
  return cached.length > 0;
}

/** 保存 / 清除 Key（传空字符串即清除） */
export async function saveKey(k: string): Promise<void> {
  cached = k.trim();
  try {
    if (cached) await AsyncStorage.setItem(K_KEY, cached);
    else await AsyncStorage.removeItem(K_KEY);
  } catch {}
}

/** 界面上显示的脱敏形式：a481 **** d0ef */
export function maskKey(k: string): string {
  const s = k.trim();
  if (!s) return '未配置';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)} **** ${s.slice(-4)}`;
}

/** 高德 Web 服务 Key 固定是 32 位十六进制，先在本地挡掉错字 */
export function looksLikeKey(k: string): boolean {
  return /^[0-9a-f]{32}$/i.test(k.trim());
}

const CHECK_URL = 'https://restapi.amap.com/v3/geocode/geo?address=%E5%8C%97%E4%BA%AC&key=';

/**
 * 真联网验证一次 Key：拿一个固定地址去请求地理编码，看高德认不认。
 *
 * 返回 null = 可用；返回字符串 = 给用户看的原因。
 * 这一步很重要，能当场发现「复制少了两位」「建成了 JS API 的 Key」这类问题，
 * 否则要等到算路时才报错，用户不知道是自己 Key 的问题。
 */
export async function verifyKey(k: string): Promise<string | null> {
  const key = k.trim();
  if (!key) return 'Key 不能为空';

  let j: any = null;
  try {
    const r = await fetch(CHECK_URL + encodeURIComponent(key));
    j = await r.json();
  } catch {
    return '网络不通，无法验证。连上网再试一次';
  }

  if (String(j?.status) === '1') return null;

  const code = String(j?.infocode ?? '');
  const known: Record<string, string> = {
    '10001': '这个 Key 无效。检查是否完整复制了 32 位，中间有没有漏字符',
    '10009': 'Key 平台不对。必须在控制台创建「Web服务」类型的 Key，不是「Web端(JS API)」也不是「iOS」',
    '10003': '这个 Key 今天的额度已经用完，明天再试，或换一个 Key',
    '10013': '这个 Key 已被删除，去控制台重新创建一个',
    '10021': '调用太频繁被临时限流，等几秒再点「验证并保存」',
  };
  return known[code] ?? `验证失败：${j?.info ?? '未知错误'}（${code || '无错误码'}）`;
}

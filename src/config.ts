/**
 * 高德 Web 服务 Key。
 *
 * 不要把这个 Key 写进代码。在项目根目录建一个 `.env` 文件：
 *
 *   EXPO_PUBLIC_AMAP_KEY=你的Key
 *
 * Expo 会在打包时把 `EXPO_PUBLIC_` 开头的变量内联进 JS 包里。
 * `.env` 已被 .gitignore 忽略，不会被提交。
 */
export const AMAP_KEY: string = process.env.EXPO_PUBLIC_AMAP_KEY ?? '';

/** 是否配置了 Key，没配时界面上会提示 */
export const HAS_KEY: boolean = AMAP_KEY.trim().length > 0;

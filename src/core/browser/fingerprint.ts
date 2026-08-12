/**
 * FingerprintEngine — 自建浏览器指纹引擎
 * 
 * 参考 AdsPower 的指纹参数体系，通过 Playwright 实现：
 * - Canvas 指纹噪声
 * - WebGL 指纹伪装
 * - AudioContext 指纹噪声
 * - 字体列表伪装
 * - Navigator 属性覆盖
 * - 屏幕/视口属性
 * - 时区/语言/地理定位
 * - WebRTC 泄露防护
 * 
 * 每个账号生成一套独立且一致的指纹参数，存储在本地
 */

import { randomInt } from '../../utils/human-behavior';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../../config';

const FINGERPRINT_DIR = path.join(DATA_DIR, 'fingerprints');

// ==================== 指纹配置 ====================

export interface FingerprintConfig {
  /** 用户代理 */
  userAgent: string;
  /** 平台 */
  platform: string;
  /** 屏幕分辨率 */
  screenWidth: number;
  screenHeight: number;
  /** 视口大小 */
  viewportWidth: number;
  viewportHeight: number;
  /** 颜色深度 */
  colorDepth: number;
  /** 设备像素比 */
  deviceScaleFactor: number;
  /** 时区 */
  timezone: string;
  /** 语言 */
  locale: string;
  /** 地理位置 */
  geolocation: { latitude: number; longitude: number; accuracy: number };
  /** CPU 核心数 */
  hardwareConcurrency: number;
  /** 设备内存 (GB) */
  deviceMemory: number;
  /** Canvas 噪声种子 (0-1) */
  canvasNoise: number;
  /** WebGL 伪装厂商 */
  webglVendor: string;
  /** WebGL 伪装渲染器 */
  webglRenderer: string;
  /** AudioContext 噪声种子 */
  audioNoise: number;
  /** 字体列表 */
  fonts: string[];
  /** 是否禁用 WebRTC */
  disableWebRTC: boolean;
  /** 是否伪装触摸支持 */
  hasTouch: boolean;
  /** 最大触摸点数 */
  maxTouchPoints: number;
}

// ==================== 预设数据 ====================

const CHROME_VERSIONS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
];

const SCREEN_RESOLUTIONS = [
  { w: 1920, h: 1080 },
  { w: 1366, h: 768 },
  { w: 1536, h: 864 },
  { w: 1440, h: 900 },
  { w: 1680, h: 1050 },
  { w: 2560, h: 1440 },
];

const WEBGL_VENDORS = [
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 630 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0)' },
];

const COMMON_FONTS_ZH_TW = [
  'Arial', 'Microsoft JhengHei', 'Microsoft YaHei', 'PMingLiU', 'MingLiU',
  'SimSun', 'NSimSun', 'FangSong', 'KaiTi', 'SimHei',
  'Times New Roman', 'Courier New', 'Georgia', 'Verdana', 'Tahoma',
  'Trebuchet MS', 'Comic Sans MS', 'Impact', 'Lucida Console',
  'Segoe UI', 'Calibri', 'Cambria', 'Candara', 'Consolas', 'Constantia', 'Corbel',
];

const TAIWAN_LOCATIONS = [
  { lat: 25.0330, lng: 121.5654, name: '台北' },
  { lat: 25.0911, lng: 121.5598, name: '台北内湖' },
  { lat: 25.0450, lng: 121.5170, name: '台北中正' },
  { lat: 24.1477, lng: 120.6736, name: '台中' },
  { lat: 22.6273, lng: 120.3014, name: '高雄' },
  { lat: 22.9999, lng: 120.2269, name: '台南' },
  { lat: 24.9936, lng: 121.3010, name: '桃园' },
  { lat: 24.8062, lng: 120.9703, name: '新竹' },
];

// ==================== 指纹引擎 ====================

export class FingerprintEngine {
  private configs: Map<string, FingerprintConfig> = new Map();

  /**
   * 为一个账号生成全新的随机指纹配置
   */
  generate(accountId: string): FingerprintConfig {
    const resolution = SCREEN_RESOLUTIONS[randomInt(0, SCREEN_RESOLUTIONS.length - 1)];
    const webgl = WEBGL_VENDORS[randomInt(0, WEBGL_VENDORS.length - 1)];
    const location = TAIWAN_LOCATIONS[randomInt(0, TAIWAN_LOCATIONS.length - 1)];
    const fonts = this.pickRandomFonts(15 + randomInt(0, 10));

    const config: FingerprintConfig = {
      userAgent: CHROME_VERSIONS[randomInt(0, CHROME_VERSIONS.length - 1)],
      platform: 'Win32',
      screenWidth: resolution.w,
      screenHeight: resolution.h,
      viewportWidth: resolution.w - randomInt(0, 100),
      viewportHeight: resolution.h - randomInt(80, 150),
      colorDepth: 24,
      deviceScaleFactor: [1, 1.25, 1.5, 2][randomInt(0, 3)],
      timezone: 'Asia/Taipei',
      locale: 'zh-TW',
      geolocation: { latitude: location.lat, longitude: location.lng, accuracy: 20 + Math.random() * 50 },
      hardwareConcurrency: [2, 4, 6, 8, 12, 16][randomInt(0, 5)],
      deviceMemory: [2, 4, 8, 16][randomInt(0, 3)],
      canvasNoise: Math.random(),
      webglVendor: webgl.vendor,
      webglRenderer: webgl.renderer,
      audioNoise: 0.001 + Math.random() * 0.01,
      fonts,
      disableWebRTC: true,
      hasTouch: false,
      maxTouchPoints: 0,
    };

    this.configs.set(accountId, config);
    this.save(accountId, config);
    return config;
  }

  /**
   * 获取账号的指纹配置（仅在内存中查找，不落盘）
   */
  get(accountId: string): FingerprintConfig | undefined {
    return this.configs.get(accountId);
  }

  /**
   * 讀取已持久化的指紋；若不存在則生成並落盤。
   * 關鍵：同一帳號每次啟動都拿到「同一套」指紋，避免 FB 偵測到設備變化。
   */
  loadOrCreate(accountId: string): FingerprintConfig {
    try {
      fs.mkdirSync(FINGERPRINT_DIR, { recursive: true });
      const file = path.join(FINGERPRINT_DIR, `${sanitizeId(accountId)}.json`);
      if (fs.existsSync(file)) {
        const cfg = JSON.parse(fs.readFileSync(file, 'utf-8')) as FingerprintConfig;
        this.configs.set(accountId, cfg);
        return cfg;
      }
    } catch (e: any) {
      console.log(`[Fingerprint] 讀取失敗，重新生成: ${e.message}`);
    }
    return this.generate(accountId);
  }

  /** 將指紋落盤（跨重啟保持穩定） */
  save(accountId: string, config: FingerprintConfig): void {
    try {
      fs.mkdirSync(FINGERPRINT_DIR, { recursive: true });
      const file = path.join(FINGERPRINT_DIR, `${sanitizeId(accountId)}.json`);
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
    } catch (e: any) {
      console.log(`[Fingerprint] 保存失敗: ${e.message}`);
    }
  }

  /** 重新生成並覆蓋（極少使用，例如帳號被標記需換設備指紋） */
  reset(accountId: string): FingerprintConfig {
    const f = path.join(FINGERPRINT_DIR, `${sanitizeId(accountId)}.json`);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    this.configs.delete(accountId);
    return this.generate(accountId);
  }

  /**
   * 生成 Playwright 的 addInitScript 注入代码
   * 这是核心——在页面加载前覆盖所有指纹 API
   */
  buildInitScript(config: FingerprintConfig): string {
    return `
// ===== Aike-FBclaw Fingerprint Shield =====
(function() {
  'use strict';

  // 1. 移除 webdriver 标记
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // 2. 覆盖 plugins 数组
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 },
      ];
      plugins.item = (i) => plugins[i];
      plugins.namedItem = (n) => plugins.find(p => p.name === n);
      plugins.refresh = () => {};
      return plugins;
    }
  });

  // 3. 覆盖 mimeTypes
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => {
      const types = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      ];
      types.item = (i) => types[i];
      types.namedItem = (n) => types.find(t => t.type === n);
      return types;
    }
  });

  // 4. 覆盖语言
  Object.defineProperty(navigator, 'language', { get: () => '${config.locale}' });
  Object.defineProperty(navigator, 'languages', { get: () => ['${config.locale}', 'zh', 'en', 'en-US'] });

  // 5. 覆盖平台
  Object.defineProperty(navigator, 'platform', { get: () => '${config.platform}' });

  // 6. 覆盖硬件信息
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${config.hardwareConcurrency} });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => ${config.deviceMemory} });

  // 7. 覆盖最大触摸点数
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => ${config.maxTouchPoints} });

  // 8. Canvas 指纹噪声（修正：原实现改了 imageData 卻未 putImageData，等同無效。
  //    現改為複製到臨時 canvas 注入噪聲後回傳，不污染原 canvas、同時覆蓋 toDataURL 與 toBlob）
  const noise = ${config.canvasNoise};
  const clamp = (v) => Math.min(255, Math.max(0, v + (noise - 0.5) * 2));
  const applyNoise = (src) => {
    try {
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      const cx = c.getContext('2d');
      if (!cx || c.width === 0 || c.height === 0) return src;
      cx.drawImage(src, 0, 0);
      const img = cx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = clamp(img.data[i]);
        img.data[i + 1] = clamp(img.data[i + 1]);
        img.data[i + 2] = clamp(img.data[i + 2]);
      }
      cx.putImageData(img, 0, 0);
      return c;
    } catch (e) { return src; }
  };
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
    try { return origToDataURL.call(applyNoise(this), type, quality); }
    catch (e) { return origToDataURL.apply(this, arguments); }
  };
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  if (origToBlob) {
    HTMLCanvasElement.prototype.toBlob = function(cb, type, quality) {
      try { return origToBlob.call(applyNoise(this), cb, type, quality); }
      catch (e) { return origToBlob.apply(this, arguments); }
    };
  }

  // 9. WebGL 指纹伪装
  const origGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(pname) {
    // UNMASKED_VENDOR_WEBGL
    if (pname === 37445) return '${config.webglVendor}';
    // UNMASKED_RENDERER_WEBGL  
    if (pname === 37446) return '${config.webglRenderer}';
    return origGetParameter.call(this, pname);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(pname) {
      if (pname === 37445) return '${config.webglVendor}';
      if (pname === 37446) return '${config.webglRenderer}';
      return origGetParameter2.call(this, pname);
    };
  }

  // 10. AudioContext 噪声（覆蓋所有頻域/時域取樣接口，避免被多路徑採樣識別）
  const audioNoise = ${config.audioNoise};
  const audioClamp = (v) => Math.min(255, Math.max(0, v + (audioNoise * 255 - audioNoise * 127)));
  const wrapAnalyser = (analyser) => {
    if (analyser.getByteFrequencyData) {
      const o = analyser.getByteFrequencyData;
      analyser.getByteFrequencyData = function(a) { o.call(this, a); for (let i = 0; i < a.length; i += 10) a[i] = audioClamp(a[i]); };
    }
    if (analyser.getFloatFrequencyData) {
      const o = analyser.getFloatFrequencyData;
      analyser.getFloatFrequencyData = function(a) { o.call(this, a); for (let i = 0; i < a.length; i += 10) a[i] = (a[i] || 0) + (audioNoise - 0.5); };
    }
    if (analyser.getByteTimeDomainData) {
      const o = analyser.getByteTimeDomainData;
      analyser.getByteTimeDomainData = function(a) { o.call(this, a); for (let i = 0; i < a.length; i += 10) a[i] = audioClamp(a[i]); };
    }
    if (analyser.getFloatTimeDomainData) {
      const o = analyser.getFloatTimeDomainData;
      analyser.getFloatTimeDomainData = function(a) { o.call(this, a); for (let i = 0; i < a.length; i += 10) a[i] = (a[i] || 0) + (audioNoise - 0.5); };
    }
    return analyser;
  };
  if (typeof AudioContext !== 'undefined') {
    const origCreateAnalyser = AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser = function() { return wrapAnalyser(origCreateAnalyser.call(this)); };
    const origCreateOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function() {
      const osc = origCreateOscillator.call(this);
      const origStart = osc.start;
      osc.start = function(when) { return origStart.call(this, when || 0); };
      return osc;
    };
  }
  if (typeof (window.OfflineAudioContext || window.webkitOfflineAudioContext) !== 'undefined') {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const origCreateAnalyser2 = OAC.prototype.createAnalyser;
    OAC.prototype.createAnalyser = function() { return wrapAnalyser(origCreateAnalyser2.call(this)); };
  }

  // 11. 覆盖屏幕属性
  Object.defineProperty(screen, 'width', { get: () => ${config.screenWidth} });
  Object.defineProperty(screen, 'height', { get: () => ${config.screenHeight} });
  Object.defineProperty(screen, 'availWidth', { get: () => ${config.screenWidth} });
  Object.defineProperty(screen, 'availHeight', { get: () => ${config.screenHeight - 40} });
  Object.defineProperty(screen, 'colorDepth', { get: () => ${config.colorDepth} });
  Object.defineProperty(screen, 'pixelDepth', { get: () => ${config.colorDepth} });

  // 12. 覆盖 window 属性（outer 跟隨真實視窗，避免與 inner 差距過大被偵測；適配平鋪小視窗）
  Object.defineProperty(window, 'outerWidth', { get: () => document.documentElement.clientWidth });
  Object.defineProperty(window, 'outerHeight', { get: () => document.documentElement.clientHeight + 80 });
  // innerWidth/innerHeight 使用真实 CSS 视口，让响应式布局跟随窗口大小
  Object.defineProperty(window, 'innerWidth', { get: () => document.documentElement.clientWidth });
  Object.defineProperty(window, 'innerHeight', { get: () => document.documentElement.clientHeight });

  // 13. 单次覆盖 devicePixelRatio (不可枚举避免被检测)
  const dpr = ${config.deviceScaleFactor};
  Object.defineProperty(window, 'devicePixelRatio', { 
    get: () => dpr, 
    configurable: true 
  });

  // 14. 处理 Chrome 的自动化检测属性
  delete window.__nightmare;
  delete window._Selenium_IDE_Recorder;
  delete window.callSelenium;
  delete window._phantom;
  delete window.__webdriver_evaluate;
  delete window.__webdriver_script_function;
  delete window.__webdriver_script_func;
  delete window.__webdriver_script_fn;
  delete window.__fxdriver_evaluate;
  delete window.__driver_unwrapped;
  delete window.__webdriver_unwrapped;
  delete window.__selenium_evaluate;
  delete window.__selenium_unwrapped;
  delete window.__webdriverOriginal;
  delete window.__webdriverFunc;
  delete window.__$webdriverAsyncExecutor;

  // 15. 覆盖权限查询
  const origQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = function(parameters) {
    if (parameters.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission === 'granted' ? 'granted' : 'prompt' });
    }
    return origQuery.call(this, parameters);
  };

  console.log('[FBclaw] Fingerprint shield applied for account');
})();
`;
  }

  /**
   * 生成 Playwright 的浏览器上下文选项
   */
  buildContextOptions(config: FingerprintConfig): any {
    return {
      userAgent: config.userAgent,
      locale: config.locale,
      timezoneId: config.timezone,
      geolocation: config.geolocation,
      permissions: ['geolocation'],
      colorScheme: 'light' as const,
      deviceScaleFactor: config.deviceScaleFactor,
      isMobile: false,
      hasTouch: config.hasTouch,
    };
  }

  /**
   * 生成與偽裝 UA 完全一致的 Client Hints（Sec-CH-UA-*）中繼資料。
   * 透過 CDP Emulation.setUserAgentOverride 注入，使瀏覽器送出的
   * Sec-CH-UA / Sec-CH-UA-Platform / Sec-CH-UA-Mobile 與我們覆寫的 UA 對齊，
   * 避免「UA 是舊版 Chrome 但 Client Hints 暴露真實新版」的常見穿幫。
   * 注意：我們本身使用真 Chromium + 真實 Chrome UA，TLS/JA3 天然與 Chrome 一致，
   * 因此 JA3 不需額外偽裝；此處只補齊 JS 層之外的 Client Hints 一致性。
   */
  buildUserAgentMetadata(config: FingerprintConfig): any {
    const m = /Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(config.userAgent);
    const major = m ? m[1] : '131';
    const full = m ? `${m[1]}.${m[2]}.${m[3]}.${m[4]}` : '131.0.0.0';
    return {
      brands: [
        { brand: 'Not A(Brand', version: '99' },
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
      ],
      fullVersionList: [
        { brand: 'Not A(Brand', version: '99.0.0.0' },
        { brand: 'Chromium', version: full },
        { brand: 'Google Chrome', version: full },
      ],
      platform: 'Windows',
      platformVersion: '10.0.0',
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    };
  }

  /** 依 locale 產生 Accept-Language 標頭值（與瀏覽器語言一致） */
  buildAcceptLanguage(config: FingerprintConfig): string {
    const base = config.locale.split('-')[0];
    return `${config.locale},${base};q=0.9,en;q=0.8`;
  }

  /**
   * 生成 Chromium 启动参数
   */
  buildLaunchArgs(config: FingerprintConfig, proxy?: string): string[] {
    const args: string[] = [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      // 禁用 Chromium 崩潰/異常關閉後的「還原網頁」氣泡與會話恢復，避免阻塞自動化
      '--hide-crash-restore-bubble',
      '--disable-restore-session-state',
      '--disable-session-crashed-bubble',
      `--window-size=${config.viewportWidth},${config.viewportHeight}`,
      `--lang=${config.locale}`,
    ];

    // WebRTC 防护
    if (config.disableWebRTC) {
      args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
      args.push('--enforce-webrtc-ip-permission-check');
    }

    // 代理配置
    if (proxy) {
      args.push(`--proxy-server=${proxy}`);
    }

    return args;
  }

  private pickRandomFonts(count: number): string[] {
    const shuffled = [...COMMON_FONTS_ZH_TW].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-40);
}

/** 取得某账号指纹文件的完整路径（供删除/排查时精确清理） */
export function fingerprintFilePath(accountId: string): string {
  return path.join(FINGERPRINT_DIR, `${sanitizeId(accountId)}.json`);
}

// 全局单例
let engineInstance: FingerprintEngine | null = null;

export function getFingerprintEngine(): FingerprintEngine {
  if (!engineInstance) {
    engineInstance = new FingerprintEngine();
  }
  return engineInstance;
}

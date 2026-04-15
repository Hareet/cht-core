/**
 * Chrome DevTools Protocol throttling profiles for simulating
 * Android 10 Go edition devices in desktop Chrome.
 *
 * Usage:
 *
 * 1. Manual (Chrome DevTools):
 *    - Network: DevTools → Network → Throttling → Add custom profile
 *      Name: "Go Edition 3G", Download: 1600 Kbps, Upload: 768 Kbps, Latency: 300ms
 *    - CPU: DevTools → Performance → CPU → 4x slowdown
 *    - Memory: Not directly settable in DevTools; use Chrome flags:
 *      --js-flags="--max-old-space-size=512" (limits V8 heap to ~512MB)
 *
 * 2. Puppeteer / Playwright (automated):
 *    ```
 *    import { GO_EDITION_PROFILES } from './go-edition-throttle';
 *    const client = await page.target().createCDPSession();
 *    await client.send('Network.emulateNetworkConditions', GO_EDITION_PROFILES.network);
 *    await client.send('Emulation.setCPUThrottlingRate', GO_EDITION_PROFILES.cpu);
 *    ```
 *
 * Device reference: Tecno Pop 5 Go / Itel A27
 *   - SoC: MediaTek Helio A22 (MT6761), 4x Cortex-A53 @ 2.0GHz
 *   - RAM: 2GB (Android Go reserves ~800MB for system)
 *   - Storage: ~11GB eMMC (~10GB usable)
 *   - WebView: 122.0.6261.90 (pinned, no updates)
 *   - Network: Typical CIV field conditions = 3G with high latency
 */

/**
 * Chrome DevTools Protocol network throttling parameters.
 * Simulates 3G conditions typical of CIV rural areas.
 *
 * Maps to: `Network.emulateNetworkConditions` CDP method.
 */
export const GO_EDITION_NETWORK = {
  offline: false,
  /** Download throughput in bytes/sec (1600 Kbps = 200 KB/s) */
  downloadThroughput: 200 * 1024,
  /** Upload throughput in bytes/sec (768 Kbps = 96 KB/s) */
  uploadThroughput: 96 * 1024,
  /** Additional latency in ms (300ms round-trip typical for 3G in CIV) */
  latency: 300,
};

/**
 * CDP CPU throttling rate.
 * 4x slowdown approximates MediaTek Helio A22 relative to a modern
 * desktop CPU (based on Geekbench 5 single-core: ~130 vs ~1500).
 *
 * Maps to: `Emulation.setCPUThrottlingRate` CDP method.
 */
export const GO_EDITION_CPU = {
  /** Throttling rate (1 = no throttle, 4 = 4x slower) */
  rate: 4,
};

/**
 * Memory budget for Go edition simulation.
 * Android Go with 2GB RAM leaves ~400-500MB for WebView after system,
 * Android services, and cht-android native overhead.
 *
 * Not directly enforceable via CDP. Use Chrome launch flags:
 *   --js-flags="--max-old-space-size=512"
 *   --disable-features=V8Sparkplug (disables JIT tier, closer to low-end behavior)
 *
 * Or use Puppeteer launch args:
 *   puppeteer.launch({ args: ['--js-flags=--max-old-space-size=512'] })
 */
export const GO_EDITION_MEMORY = {
  /** V8 heap limit in MB */
  maxOldSpaceSizeMB: 512,
  /** Chrome launch flag string */
  chromeLaunchFlag: '--js-flags=--max-old-space-size=512',
};

/**
 * Combined profile for automated test frameworks.
 */
export const GO_EDITION_PROFILES = {
  network: GO_EDITION_NETWORK,
  cpu: GO_EDITION_CPU,
  memory: GO_EDITION_MEMORY,

  /** User agent string matching the dominant fleet device */
  userAgent: 'Mozilla/5.0 (Linux; Android 10; TECNO BC2c Build/QP1A.190711.020) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.90 '
    + 'Mobile Safari/537.36',

  /** Screen dimensions matching Tecno Pop 5 Go */
  screen: {
    width: 720,
    height: 1600,
    deviceScaleFactor: 2,
    mobile: true,
  },
};

/**
 * Apply Go edition throttling to a Puppeteer CDP session.
 *
 * Usage:
 *   const client = await page.target().createCDPSession();
 *   await applyGoEditionThrottling(client);
 */
export async function applyGoEditionThrottling(cdpSession: any): Promise<void> {
  await cdpSession.send('Network.emulateNetworkConditions', GO_EDITION_NETWORK);
  await cdpSession.send('Emulation.setCPUThrottlingRate', GO_EDITION_CPU);
}

/**
 * Remove throttling from a Puppeteer CDP session.
 */
export async function clearThrottling(cdpSession: any): Promise<void> {
  await cdpSession.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  });
  await cdpSession.send('Emulation.setCPUThrottlingRate', { rate: 1 });
}

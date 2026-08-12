// Minimal offline wrapper matching the KernelSU WebUI JavaScript bridge.
export function exec(command, options = {}) {
  return new Promise((resolve) => {
    if (!window.ksu || typeof window.ksu.exec !== 'function') {
      resolve({ errno: 127, stdout: '', stderr: 'KernelSU JavaScript bridge is unavailable.' });
      return;
    }
    const callbackName = `oplus_brightness_cb_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    window[callbackName] = (errno, stdout, stderr) => {
      delete window[callbackName];
      resolve({ errno: Number(errno || 0), stdout: stdout || '', stderr: stderr || '' });
    };
    try {
      window.ksu.exec(command, JSON.stringify(options), callbackName);
    } catch (error) {
      delete window[callbackName];
      resolve({ errno: 126, stdout: '', stderr: String(error) });
    }
  });
}

export function toast(message) {
  try {
    if (window.ksu && typeof window.ksu.toast === 'function') window.ksu.toast(String(message));
  } catch (_) { /* Browser fallback uses dialogs. */ }
}


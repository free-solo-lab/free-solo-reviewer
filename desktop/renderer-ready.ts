/** Self-contained: Electron serializes this function into the isolated renderer. */
export function waitForRendererReady(timeoutMs = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(
      () => finish(new Error('Reviewer UI did not become ready')),
      timeoutMs,
    );
    function finish(error?: Error) {
      clearTimeout(timer);
      observer.disconnect();
      if (error) reject(error);
      else resolve();
    }
    function check() {
      if (document.querySelector('#root .startup-screen[role="alert"]'))
        finish(new Error('Reviewer UI failed to start'));
      else if (document.querySelector('#root .app-shell')) finish();
    }
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    check();
  });
}

(() => {
  if (document.getElementById('prMediaCursor')) return 'present';
  const urlBar = document.createElement('div');
  urlBar.id = 'prMediaUrlBar';
  urlBar.style.cssText = 'position:fixed;left:0;top:0;right:0;height:34px;box-sizing:border-box;padding:0 14px;display:flex;align-items:center;gap:10px;background:#0b0d12;color:#dce1ea;font:14px -apple-system,Helvetica,Arial,sans-serif;border-bottom:1px solid #2a3040;z-index:2147483646;pointer-events:none;';
  urlBar.innerHTML = '<span style="width:9px;height:9px;border-radius:50%;background:#4cae5a;flex:none"></span><span id="prMediaUrlText" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span>';
  document.documentElement.appendChild(urlBar);
  const paintUrl = () => { document.getElementById('prMediaUrlText').textContent = location.href; };
  paintUrl();
  window.addEventListener('popstate', paintUrl);
  window.addEventListener('hashchange', paintUrl);
  const pushState = history.pushState.bind(history);
  history.pushState = (...args) => { pushState(...args); paintUrl(); };
  document.body.style.marginTop = (parseFloat(getComputedStyle(document.body).marginTop) || 0) + 34 + 'px';

  const cursor = document.createElement('div');
  cursor.id = 'prMediaCursor';
  cursor.style.cssText = 'position:fixed;left:50%;top:50%;width:26px;height:26px;pointer-events:none;z-index:2147483647;transform:translate(-4px,-2px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));';
  cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13.5 19 L10.5 12.8 L16.5 12.8 Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cursor);
  const place = (x, y) => { cursor.style.left = x + 'px'; cursor.style.top = y + 'px'; };
  window.addEventListener('mousemove', e => place(e.clientX, e.clientY), true);
  const ripple = (x, y) => {
    const ring = document.createElement('div');
    ring.style.cssText = 'position:fixed;border-radius:50%;pointer-events:none;z-index:2147483646;box-sizing:border-box;';
    document.body.appendChild(ring);
    const startedAt = performance.now();
    const durationMs = 700;
    const frame = now => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const size = 14 + 76 * eased;
      const alpha = 1 - eased;
      ring.style.width = size + 'px';
      ring.style.height = size + 'px';
      ring.style.left = (x - size / 2) + 'px';
      ring.style.top = (y - size / 2) + 'px';
      ring.style.border = '4px solid rgba(91,140,255,' + alpha + ')';
      ring.style.background = 'rgba(91,140,255,' + (alpha * 0.3) + ')';
      if (t < 1) requestAnimationFrame(frame); else ring.remove();
    };
    requestAnimationFrame(frame);
  };
  const cursorSvg = cursor.firstElementChild;
  window.addEventListener('mousedown', e => { cursorSvg.setAttribute('width', '18'); cursorSvg.setAttribute('height', '18'); ripple(e.clientX, e.clientY); }, true);
  window.addEventListener('mouseup', () => { cursorSvg.setAttribute('width', '26'); cursorSvg.setAttribute('height', '26'); }, true);
  return 'injected';
})()

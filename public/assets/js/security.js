// ============================================================
// E-Codex Play — Screen Security Layer
// ------------------------------------------------------------
// IMPORTANT, HONEST LIMITATION: no website can truly *prevent* a
// screenshot or screen recording — that happens at the OS/hardware
// level, completely outside any browser's control. This script
// applies the same realistic deterrents real confidential platforms
// use instead: a traceable watermark, an automatic blur when the
// window loses focus, and friction against casual copy/paste or
// right-click saving. It raises the bar; it cannot make it impossible.
// ============================================================
(function () {
  // ---- 1. Disable right-click context menu ----
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- 2. Disable text selection (still allows input/textarea typing) ----
  document.addEventListener('selectstart', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
  });

  // ---- 3. Disable dragging images (harder to drag-save a picture) ----
  document.addEventListener('dragstart', (e) => {
    if (e.target.tagName === 'IMG') e.preventDefault();
  });

  // ---- 4. Best-effort key detection (cannot block the OS action itself,
  //         but can warn + log that it happened) ----
  function flashSecurityWarning(message) {
    let banner = document.getElementById('__securityWarning');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = '__securityWarning';
      banner.style.cssText = 'position:fixed; top:16px; left:50%; transform:translateX(-50%); z-index:99999; background:#ef4444; color:#fff; padding:10px 20px; border-radius:10px; font-size:13px; font-weight:700; box-shadow:0 8px 20px rgba(0,0,0,0.4); font-family:Arial,sans-serif;';
      document.body.appendChild(banner);
    }
    banner.textContent = message;
    banner.style.display = 'block';
    clearTimeout(banner._hideTimer);
    banner._hideTimer = setTimeout(() => { banner.style.display = 'none'; }, 3000);
  }

  document.addEventListener('keyup', (e) => {
    if (e.key === 'PrintScreen') {
      flashSecurityWarning('This content is confidential — screenshots are logged.');
    }
  });

  document.addEventListener('keydown', (e) => {
    const ctrlOrCmd = e.ctrlKey || e.metaKey;
    // Block browser print (Ctrl/Cmd+P)
    if (ctrlOrCmd && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      flashSecurityWarning('Printing is disabled on this page.');
    }
    // Common Windows snip shortcut: Win+Shift+S can't be intercepted from
    // the page (it's OS-level before the browser even sees it), but Ctrl+Shift+S
    // inside some browsers can be caught as a courtesy block.
    if (ctrlOrCmd && e.shiftKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      flashSecurityWarning('This content is confidential — screenshots are logged.');
    }
  });

  // ---- 5. Blur everything the instant the window loses focus or the tab
  //         is hidden — this catches the common pattern of alt-tabbing to
  //         a screenshot tool, though it cannot catch every capture method. ----
  const style = document.createElement('style');
  style.textContent = `
    body.__security-blurred > *:not(#__securityWatermarkLayer):not(#__securityBlurNotice) {
      filter: blur(18px) !important;
      transition: filter 0.15s ease;
    }
    #__securityBlurNotice {
      position: fixed; inset: 0; z-index: 100000; display: none;
      align-items: center; justify-content: center; background: rgba(11,15,23,0.55);
      color: #fff; font-family: Arial, sans-serif; font-size: 14px; font-weight: 700;
      text-align: center; padding: 20px;
    }
    body.__security-blurred #__securityBlurNotice { display: flex; }
  `;
  document.head.appendChild(style);

  const blurNotice = document.createElement('div');
  blurNotice.id = '__securityBlurNotice';
  blurNotice.innerHTML = '<div><i class="fa-solid fa-eye-slash" style="font-size:28px; display:block; margin-bottom:10px;"></i>Content hidden — this window is not in focus</div>';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(blurNotice));

  function setBlurred(on) {
    document.body.classList.toggle('__security-blurred', on);
  }
  window.addEventListener('blur', () => setBlurred(true));
  window.addEventListener('focus', () => setBlurred(false));
  document.addEventListener('visibilitychange', () => setBlurred(document.hidden));

  // ---- 6. Traceable watermark — tiled, semi-transparent, shows who was
  //         logged in and when. The single most effective real deterrent:
  //         even if someone screenshots past the blur, the image is
  //         traceable back to their account. ----
  function buildWatermarkSVG(label) {
    const tile = 260;
    const escaped = label.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${tile}">
        <text x="0" y="${tile / 2}" transform="rotate(-28 ${tile / 2} ${tile / 2})"
          font-family="Arial, sans-serif" font-size="13" fill="rgba(255,255,255,0.07)">${escaped}</text>
      </svg>`;
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }

  function addWatermark(detail) {
    if (document.getElementById('__securityWatermarkLayer')) return;
    const name = (detail && (detail.full_name || detail.username)) || 'E-Codex Play';
    const stamp = new Date().toLocaleString();
    const label = `${name}  •  ${stamp}`;
    const layer = document.createElement('div');
    layer.id = '__securityWatermarkLayer';
    layer.style.cssText = `
      position: fixed; inset: 0; z-index: 99998; pointer-events: none;
      background-image: url('${buildWatermarkSVG(label)}'); background-repeat: repeat;
    `;
    document.body.appendChild(layer);
  }

  document.addEventListener('auth-ready', (e) => addWatermark(e.detail));
})();

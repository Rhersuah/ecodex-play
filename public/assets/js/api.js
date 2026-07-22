/**
 * api.js — single shared helper for talking to the real backend.
 * Included by every page.
 *
 * IMPORTANT: the login session token is stored in sessionStorage, NOT a
 * cookie. sessionStorage is isolated per browser TAB — this is intentional
 * so that logging in as a different role (Super Admin, Admin, User) in one
 * tab never overwrites or affects the session in any other open tab on the
 * same computer/browser.
 */
const API_BASE = '/api';
const TOKEN_KEY = 'ecodex_token';

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}
function setToken(token) {
  sessionStorage.setItem(TOKEN_KEY, token);
}
function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

async function apiRequest(path, { method = 'GET', body, isForm = false } = {}) {
  const opts = {
    method,
    headers: {},
  };
  const token = getToken();
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;

  if (body !== undefined) {
    if (isForm) {
      opts.body = body; // FormData - browser sets multipart headers itself
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }

  const res = await fetch(API_BASE + path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* no JSON body */ }

  if (!res.ok) {
    if (res.status === 401 && data && data.code !== 'MUST_CHANGE_PASSWORD') {
      // Session missing/expired — bounce to sign in.
      clearToken();
      if (!window.location.pathname.includes('signin-signup')) {
        window.location.href = '/signin-signup.html';
      }
    }
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data && data.code;
    err.email = data && data.email;
    err.data = data;
    throw err;
  }
  return data;
}

const api = {
  get: (path) => apiRequest(path),
  post: (path, body, isForm = false) => apiRequest(path, { method: 'POST', body, isForm }),
  put: (path, body, isForm = false) => apiRequest(path, { method: 'PUT', body, isForm }),
  patch: (path, body, isForm = false) => apiRequest(path, { method: 'PATCH', body, isForm }),
  del: (path) => apiRequest(path, { method: 'DELETE' }),
};

// Masks a name for privacy, e.g. "Cyrus Joel L." -> "Cyr**s Jo**l L."
// Used when showing an Admin/Super Admin's real name to a user (e.g. as the
// account holder name on a deposit destination) — keeps enough of the name
// to feel authentic/verifiable, without exposing it in full.
function maskName(fullName) {
  if (!fullName) return '';
  return fullName.split(' ').map(part => {
    // Leave short words/initials (e.g. "L.", "A") untouched.
    if (part.replace(/\./g, '').length <= 2) return part;
    const keep = Math.ceil(part.length / 2);
    return part.slice(0, keep) + '**' + part.slice(-1);
  }).join(' ');
}

// Shared button loading-state helper, usable on any page.
function setBtnLoading(btnId, loading, label) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (loading) {
    btn.dataset.originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.style.cursor = 'not-allowed';
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Please wait...';
  } else {
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = '';
    btn.innerHTML = label || btn.dataset.originalHtml || btn.innerHTML;
  }
}

// Resizes/compresses an image file client-side before upload. This is the
// biggest lever for "slow to submit" complaints — raw phone photos can be
// 5-10MB; this brings them down to a fraction of that before they ever hit
// the network, which matters a lot on mobile data.
function compressImage(file, maxDimension = 1280, quality = 0.75) {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/') || file.type === 'image/gif') {
      return resolve(file); // don't touch non-images or GIFs
    }
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDimension || height > maxDimension) {
        if (width > height) { height = Math.round(height * (maxDimension / width)); width = maxDimension; }
        else { width = Math.round(width * (maxDimension / height)); height = maxDimension; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        if (!blob || blob.size >= file.size) return resolve(file); // fall back if compression didn't help
        resolve(new File([blob], file.name, { type: 'image/jpeg' }));
      }, 'image/jpeg', quality);
    };
    img.onerror = () => resolve(file); // fall back to original on any error
    reader.readAsDataURL(file);
  });
}

function pesos(n) {
  return '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function comingSoon(featureName) {
  showToast(`"${featureName}" — not yet available, coming in a future update.`, 'info');
}

// Adds a small red dot badge next to a sidebar menu-row link if count > 0.
// Usage: addNotificationDot('transaction_approval.html', count)
function addNotificationDot(hrefMatch, count) {
  document.querySelectorAll(`.menu-row[href="${hrefMatch}"], .nav-item[href="${hrefMatch}"], .related-link-row[href="${hrefMatch}"]`).forEach(el => {
    const content = el.querySelector('.menu-left-content') || el;
    let dot = content.querySelector('.notif-dot');
    if (!count || count <= 0) {
      if (dot) dot.remove();
      return;
    }
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'notif-dot';
      dot.style.cssText = 'background:#ef4444; color:#fff; font-size:10px; font-weight:700; min-width:16px; height:16px; border-radius:8px; display:inline-flex; align-items:center; justify-content:center; padding:0 4px; margin-left:6px; position:relative; top:-8px;';
      content.appendChild(dot);
    }
    dot.textContent = count > 9 ? '9+' : count;
  });
}

// ------------------------------------------------------------------
// CENTERED MODAL DIALOGS — replaces native browser alert()/confirm(),
// which look jarring and can't be styled. Injects one shared overlay
// into the page the first time it's needed.
// ------------------------------------------------------------------
function ensureModalRoot() {
  let root = document.getElementById('appModalRoot');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'appModalRoot';
  root.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:5000; align-items:center; justify-content:center; padding:20px;';
  root.innerHTML = `
    <div style="background:#131926; border:1px solid #1e293b; border-radius:20px; max-width:420px; width:100%; padding:26px; text-align:center; box-shadow:0 20px 50px rgba(0,0,0,0.6);">
      <i id="appModalIcon" class="fa-solid fa-circle-question" style="font-size:30px; color:#3b82f6; margin-bottom:12px;"></i>
      <div id="appModalMessage" style="font-size:14px; color:#e2e8f0; line-height:1.6; margin-bottom:20px; white-space:pre-line;"></div>
      <div id="appModalButtons" style="display:flex; flex-direction:column; gap:8px;"></div>
    </div>
  `;
  document.body.appendChild(root);
  return root;
}

// appConfirm(message) -> Promise<boolean>. Replaces confirm().
function appConfirm(message, okLabel = 'Confirm', cancelLabel = 'Cancel') {
  return new Promise((resolve) => {
    const root = ensureModalRoot();
    document.getElementById('appModalIcon').className = 'fa-solid fa-circle-question';
    document.getElementById('appModalIcon').style.color = '#3b82f6';
    document.getElementById('appModalMessage').textContent = message;
    const buttons = document.getElementById('appModalButtons');
    buttons.innerHTML = '';

    const okBtn = document.createElement('button');
    okBtn.textContent = okLabel;
    okBtn.style.cssText = 'padding:12px; border:none; border-radius:10px; background:#10b981; color:#fff; font-weight:700; font-size:13px; cursor:pointer;';
    okBtn.onclick = () => { root.style.display = 'none'; resolve(true); };

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = cancelLabel;
    cancelBtn.style.cssText = 'padding:12px; border:none; border-radius:10px; background:#1e293b; color:#94a3b8; font-weight:600; font-size:13px; cursor:pointer;';
    cancelBtn.onclick = () => { root.style.display = 'none'; resolve(false); };

    buttons.appendChild(okBtn);
    buttons.appendChild(cancelBtn);
    root.style.display = 'flex';
  });
}

// appAlert(message) -> Promise<void>. Replaces alert().
function appAlert(message, type = 'info') {
  return new Promise((resolve) => {
    const root = ensureModalRoot();
    const icon = document.getElementById('appModalIcon');
    icon.className = type === 'error' ? 'fa-solid fa-circle-exclamation' : type === 'success' ? 'fa-solid fa-circle-check' : 'fa-solid fa-circle-info';
    icon.style.color = type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#3b82f6';
    document.getElementById('appModalMessage').textContent = message;
    const buttons = document.getElementById('appModalButtons');
    buttons.innerHTML = '';

    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.style.cssText = 'padding:12px; border:none; border-radius:10px; background:#10b981; color:#fff; font-weight:700; font-size:13px; cursor:pointer;';
    okBtn.onclick = () => { root.style.display = 'none'; resolve(); };

    buttons.appendChild(okBtn);
    root.style.display = 'flex';
  });
}

// appChoice(message, [{label, value, color}]) -> Promise<value|null>.
// For 3+ way decisions (e.g. "Return tickets" vs "Delete tickets" vs "Cancel").
function appChoice(message, options) {
  return new Promise((resolve) => {
    const root = ensureModalRoot();
    document.getElementById('appModalIcon').className = 'fa-solid fa-circle-question';
    document.getElementById('appModalIcon').style.color = '#f59e0b';
    document.getElementById('appModalMessage').textContent = message;
    const buttons = document.getElementById('appModalButtons');
    buttons.innerHTML = '';

    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.textContent = opt.label;
      btn.style.cssText = `padding:12px; border:none; border-radius:10px; background:${opt.color || '#334155'}; color:#fff; font-weight:700; font-size:13px; cursor:pointer;`;
      btn.onclick = () => { root.style.display = 'none'; resolve(opt.value); };
      buttons.appendChild(btn);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:12px; border:none; border-radius:10px; background:#1e293b; color:#94a3b8; font-weight:600; font-size:13px; cursor:pointer;';
    cancelBtn.onclick = () => { root.style.display = 'none'; resolve(null); };
    buttons.appendChild(cancelBtn);

    root.style.display = 'flex';
  });
}

// Small realistic icon used for Item Collection Events — pure SVG, no
// image file needed. `type` selects the design: 'shard', 'chest', 'coins',
// or 'diamond'.
function itemIconSVG(type, size = 32) {
  const uid = Math.random().toString(36).slice(2, 8); // unique gradient IDs so multiple icons on one page don't clash
  if (type === 'chest') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="chestWood${uid}" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#c2803f"/><stop offset="100%" stop-color="#8b5a2b"/>
        </linearGradient>
        <linearGradient id="chestGold${uid}" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#fde68a"/><stop offset="100%" stop-color="#d97706"/>
        </linearGradient>
      </defs>
      <rect x="12" y="45" width="76" height="40" rx="6" fill="url(#chestWood${uid})" stroke="#5c3a1a" stroke-width="2"/>
      <path d="M12 45 Q50 20 88 45" fill="url(#chestWood${uid})" stroke="#5c3a1a" stroke-width="2"/>
      <rect x="8" y="44" width="84" height="8" rx="3" fill="url(#chestGold${uid})" stroke="#92400e" stroke-width="1.5"/>
      <circle cx="50" cy="58" r="8" fill="url(#chestGold${uid})" stroke="#92400e" stroke-width="1.5"/>
      <rect x="46" y="55" width="8" height="10" rx="2" fill="#78350f"/>
    </svg>`;
  }
  if (type === 'coins') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="coinGrad${uid}" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stop-color="#fef3c7"/><stop offset="55%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#b45309"/>
        </radialGradient>
      </defs>
      <ellipse cx="35" cy="68" rx="26" ry="9" fill="#b45309" opacity="0.5"/>
      <circle cx="35" cy="60" r="24" fill="url(#coinGrad${uid})" stroke="#92400e" stroke-width="2"/>
      <text x="35" y="68" font-size="22" text-anchor="middle" fill="#92400e" font-weight="800" font-family="Arial">₱</text>
      <circle cx="66" cy="42" r="20" fill="url(#coinGrad${uid})" stroke="#92400e" stroke-width="2"/>
      <text x="66" y="49" font-size="18" text-anchor="middle" fill="#92400e" font-weight="800" font-family="Arial">₱</text>
    </svg>`;
  }
  if (type === 'diamond') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="diaGrad${uid}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ecfeff"/><stop offset="45%" stop-color="#22d3ee"/><stop offset="100%" stop-color="#0e7490"/>
        </linearGradient>
      </defs>
      <polygon points="50,10 80,35 66,90 34,90 20,35" fill="url(#diaGrad${uid})" stroke="#a5f3fc" stroke-width="1.5" stroke-opacity="0.6"/>
      <polygon points="20,35 80,35 50,10" fill="#ffffff" opacity="0.25"/>
      <polygon points="34,90 50,10 66,90" fill="#ffffff" opacity="0.1"/>
      <line x1="50" y1="10" x2="50" y2="90" stroke="#ffffff" stroke-width="1.5" opacity="0.4"/>
    </svg>`;
  }
  return shardIconSVG(size); // default: shard
}

// Small faceted crystal icon used everywhere shards are shown (collect
// button, popup, Inventory). Pure SVG — no image file needed.
function shardIconSVG(size = 32) {
  const uid = Math.random().toString(36).slice(2, 8);
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 160" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="shardGrad${uid}" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#f5eaff"/>
        <stop offset="35%" stop-color="#c084fc"/>
        <stop offset="70%" stop-color="#9333ea"/>
        <stop offset="100%" stop-color="#5b21b6"/>
      </linearGradient>
      <radialGradient id="shardGlow${uid}" cx="50%" cy="15%" r="60%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.9"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <polygon points="50,4 74,48 68,100 60,150 40,150 32,100 26,48" fill="url(#shardGrad${uid})" stroke="#f3e8ff" stroke-width="1.5" stroke-opacity="0.6"/>
    <polygon points="50,4 62,50 58,150 40,150 26,48" fill="#ffffff" opacity="0.12"/>
    <polygon points="26,48 50,4 32,100" fill="url(#shardGlow${uid})" opacity="0.5"/>
    <line x1="50" y1="4" x2="45" y2="150" stroke="#ffffff" stroke-width="1.5" opacity="0.45"/>
    <line x1="26" y1="48" x2="74" y2="48" stroke="#ffffff" stroke-width="1" opacity="0.25"/>
  </svg>`;
}

// Renders the correct badge HTML for a ticket's actual tier — used
// anywhere a ticket card shows its tier (Shop, Buy Tickets, My Tickets).
// Never hardcode "GOLD" directly; tickets can be normal, gold, or premium.
function tierBadgeHTML(tier) {
  if (tier === 'gold') {
    return '<span style="background:#eab308; color:#000; font-size:10px; font-weight:800; padding:2px 8px; border-radius:5px;">GOLD</span>';
  }
  if (tier === 'premium') {
    return '<span style="display:inline-block; background:linear-gradient(135deg, #a78bfa, #7c3aed); color:#f3e8ff; font-size:10px; font-weight:800; letter-spacing:0.5px; padding:2px 8px; border-radius:5px; box-shadow:0 0 6px rgba(167,139,250,0.7), 0 0 14px rgba(124,58,237,0.4);">PREMIUM</span>';
  }
  return '';
}

// Renders a ticket as a collectible physical-ticket-style card (not a QR
// code) — Normal is plain and functional, Gold has a metallic glowing
// finish, Premium has a glowing purple-and-gold finish with sparkle
// accents. Used everywhere a ticket is shown: Buy Tickets, Shop, My
// Tickets, and staff ticket management.
function ticketCardHTML(ticket, opts) {
  opts = opts || {};
  const tier = ticket.tier || 'normal';
  const tierClass = tier === 'gold' ? 'ecp-ticket-gold' : tier === 'premium' ? 'ecp-ticket-premium' : 'ecp-ticket-normal';
  const tierLabel = tier === 'gold' ? 'GOLDEN TICKET' : tier === 'premium' ? 'PREMIUM TICKET' : 'NORMAL TICKET';
  const subLabel = tier === 'gold' ? 'LUCKY DRAW ENTRY' : tier === 'premium' ? 'GRAND PRIZE DRAW' : 'STANDARD ENTRY';
  const priceLine = ticket.price != null ? `₱${parseFloat(ticket.price).toFixed(2)}` : '';
  const extraMeta = tier === 'premium' ? ' &middot; NON-TRANSFERABLE' : tier === 'gold' ? ' &middot; MAIN DRAW ONLY' : '';
  const decorations = tier === 'gold'
    ? '<span class="ecp-ticket-corner tc-tl">&#10022;</span><span class="ecp-ticket-corner tc-br">&#10022;</span>'
    : tier === 'premium'
    ? '<span class="ecp-sparkle sp1">&#10022;</span><span class="ecp-sparkle sp2">&#10023;</span><span class="ecp-sparkle sp3">&#10022;</span>'
    : '';
  const footerSlot = opts.footer || '';
  return `
    <div class="ecp-ticket ${tierClass}" ${opts.onclick ? `onclick="${opts.onclick}" style="cursor:pointer;"` : ''}>
      <div class="ecp-ticket-notch-line"></div>
      ${decorations}
      <div class="ecp-ticket-main">
        <div class="ecp-ticket-tier-label">${tierLabel}</div>
        <div class="ecp-ticket-code">${escapeHtml(ticket.ticket_code || '')}</div>
        <div class="ecp-ticket-sub">${subLabel}</div>
        ${priceLine ? `<div class="ecp-ticket-meta">${priceLine}${extraMeta}</div>` : ''}
      </div>
      <div class="ecp-ticket-side">
        <div class="ecp-ticket-logo"><i class="fa-solid fa-gem"></i></div>
      </div>
    </div>
    ${footerSlot}
  `;
}

function showToast(message, type = 'info') {
  let toast = document.getElementById('__globalToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = '__globalToast';
    toast.style.cssText = `
      position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
      background:#131926; color:#fff; padding:18px 26px; border-radius:14px;
      font-family:'Inter',sans-serif; font-size:14px; font-weight:600;
      border:1px solid #1e293b; z-index:9999; box-shadow:0 20px 50px rgba(0,0,0,0.6);
      max-width:min(90vw,380px); text-align:center; transition:opacity .2s, transform .2s;
      pointer-events:none;`;
    document.body.appendChild(toast);
  }
  toast.style.borderColor = type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#1e293b';
  toast.style.color = type === 'error' ? '#fca5a5' : type === 'success' ? '#6ee7b7' : '#fff';
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3500);
}

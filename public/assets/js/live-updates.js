// ============================================================
// E-Codex Play — Live Updates (no manual reload needed)
// ------------------------------------------------------------
// Opens one persistent connection to the server. The instant something
// relevant happens elsewhere in the system (a new deposit request, a new
// message, a new account waiting for approval, etc.), the server pushes a
// small signal down this connection and this script immediately re-runs
// whichever of the page's OWN existing load/refresh functions apply —
// the exact same functions the page already calls on a timer. Nothing
// about how each page fetches or renders its data has to change; this
// just makes it happen the moment it's needed instead of waiting for the
// next scheduled poll. If the connection drops (network hiccup, sleep/
// wake), the browser's built-in EventSource reconnects on its own, and
// the existing timers keep working as a safety net either way.
// ============================================================
(function () {
  // Maps a broadcast category to the possible names of refresh functions
  // that might exist on any given page. Whichever of these actually exist
  // as functions on `window` for the current page get called — pages that
  // don't have a matching function simply ignore that category.
  const CATEGORY_TO_FUNCTIONS = {
    transactions: ['loadNotificationDots', 'loadPending', 'loadTransactions', 'loadRelatedDots'],
    messages: ['loadNotificationDots', 'loadThreads', 'loadThread', 'loadMessages', 'loadRelatedDots'],
    accounts: ['loadNotificationDots', 'loadPendingAccounts', 'loadPending', 'loadRelatedDots'],
    tickets: ['loadNotificationDots', 'loadTickets', 'loadPendingTickets', 'loadRelatedDots'],
    orders: ['loadNotificationDots', 'loadOrders', 'loadPendingOrders', 'loadRelatedDots'],
    bans: ['loadNotificationDots', 'loadBanRequests', 'loadPending', 'loadRelatedDots'],
    auctions: ['loadAuctionItems', 'loadItems'],
  };

  function triggerRefresh(category) {
    const candidates = CATEGORY_TO_FUNCTIONS[category] || [];
    candidates.forEach((fnName) => {
      if (typeof window[fnName] === 'function') {
        try { window[fnName](); } catch (e) { /* the function itself will surface its own errors */ }
      }
    });
  }

  function connect() {
    if (!window.EventSource) return; // very old browser — the existing timers still work fine
    const token = typeof getToken === 'function' ? getToken() : sessionStorage.getItem('ecodex_token');
    if (!token) return; // not logged in yet — auth-guard.js will redirect shortly anyway
    const source = new EventSource('/api/shared/live-events?token=' + encodeURIComponent(token));

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.category) triggerRefresh(data.category);
      } catch (e) { /* ignore malformed payloads */ }
    };

    // EventSource reconnects automatically on error — no manual retry loop needed.
    source.onerror = () => { /* browser handles reconnection */ };

    window.addEventListener('beforeunload', () => source.close());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', connect);
  } else {
    connect();
  }
})();

// ============================================================
// E-Codex Play — Support FAQ Chatbot
// ------------------------------------------------------------
// Answers common questions instantly, any time of day, even
// when no Admin or Super Admin is currently online. If nothing
// in the knowledge base matches well enough, the question is
// forwarded into the same Support Messages thread staff already
// monitor — so nothing gets lost, it just waits for a human.
// ============================================================
(function () {
  const FAQ_DATABASE = [
    {
      keywords: ['deposit', 'paano deposit', 'how to deposit', 'add funds', 'top up', 'magdeposit'],
      question: 'How do I deposit funds?',
      answer: 'Go to Balance → Deposit. Choose a gateway (GCash/Maya/Bank), enter the amount, upload your proof of payment, and submit. A small platform service fee applies — you\'ll see the exact amount before you confirm. Your deposit needs Admin and Super Admin approval before it reflects in your balance, usually within a day.',
    },
    {
      keywords: ['withdraw', 'withdrawal', 'paano withdraw', 'how to withdraw', 'cash out', 'mag withdraw'],
      question: 'How do I withdraw funds?',
      answer: 'Go to Balance → Withdraw. Enter the amount and your account/mobile number. The amount (plus the small service fee) is held from your balance right away, and you\'ll receive the net amount once Admin and Super Admin approve the request.',
    },
    {
      keywords: ['fee', 'service fee', 'charges', 'bayad', 'singil'],
      question: 'What is the platform service fee?',
      answer: 'A small percentage fee applies to deposits and withdrawals. It goes toward keeping the platform running — system maintenance, hosting, and security. You always see the exact fee and net amount before you submit, and you must agree to it first.',
    },
    {
      keywords: ['buy ticket', 'bumili ng ticket', 'ecp ticket', 'ticket price', 'gold ticket', 'premium ticket'],
      question: 'How do I buy tickets?',
      answer: 'Go to Shop → Buy Tickets to see all available tickets. Tickets come in three tiers — Normal, Gold, and Premium. Only Normal tier tickets can be dropped into a live draw pool; Gold and Premium are collectible/high-value tickets.',
    },
    {
      keywords: ['drop ticket', 'i-drop', 'pool', 'join draw', 'sumali sa draw'],
      question: 'How do I join a live draw?',
      answer: 'Go to Inventory → Drop Tickets and drop any Normal tier ticket you own into the currently open pool before the countdown ends. Once the draw starts, the wheel spins and winners are picked and announced live.',
    },
    {
      keywords: ['live draw', 'wheel', 'paano manalo', 'how to win', 'wheel of fortune'],
      question: 'How does the Live Draw work?',
      answer: 'Once the countdown ends, the wheel automatically spins to pick winners from every ticket dropped into that draw\'s pool. You can watch the reveal live on the Live Draw page. Winning tickets go through a staff verification and approval process before the prize is credited to your balance.',
    },
    {
      keywords: ['shop', 'order', 'my orders', 'item', 'delivery', 'shipping'],
      question: 'How does the Shop and order delivery work?',
      answer: 'Browse Shop for physical items and high-value tickets. After checkout, your order goes through a 2-tier staff approval, then moves to "To Ship" and "To Receive." Check My Orders any time to track its status, and confirm once you\'ve received it.',
    },
    {
      keywords: ['auction', 'bid', 'bidding'],
      question: 'How does the Auction work?',
      answer: 'Go to Shop → Auction to see live items up for bidding. Place a bid above the current price and minimum increment. If you have the highest bid when the countdown ends, you win — the amount is only deducted from your balance at that point.',
    },
    {
      keywords: ['account approval', 'pending', 'verification code', 'signup', 'bakit hindi pa', 'why not approved', 'waiting'],
      question: 'Why is my account still pending?',
      answer: 'New accounts go through a 2-tier staff review before the verification code is released, plus a final account approval step. This keeps the platform secure since real money is involved. It can take some time depending on staff availability — thank you for your patience.',
    },
    {
      keywords: ['collection event', 'shard', 'chest', 'coins', 'diamond', 'daily collect', 'inventory'],
      question: 'What are Item Collection Events?',
      answer: 'These are limited-time daily collectibles staff can run. If one is active, you\'ll see a popup once a day to collect — the amount and item type are random. Check your Inventory to see everything you\'ve collected.',
    },
    {
      keywords: ['forgot password', 'reset password', 'can\'t login', 'cannot login', 'nakalimutan password'],
      question: 'I forgot my password — what do I do?',
      answer: 'Please reach out through this chat or Support Messages with your registered username or email, and a Super Admin can issue you a secure temporary password once they review your request.',
    },
    {
      keywords: ['ban', 'banned', 'suspended', 'bakit naban'],
      question: 'Why was my account banned?',
      answer: 'Bans are issued by staff for violations of the platform\'s terms. If you believe this was a mistake, please describe your situation here and it will be forwarded to a Super Admin for review.',
    },
    {
      keywords: ['tier', 'normal gold premium', 'difference', 'pagkakaiba'],
      question: 'What\'s the difference between Normal, Gold, and Premium tickets?',
      answer: 'Normal tickets are the standard entry, and the only tier that can be dropped into live draw pools. Gold and Premium are higher-value collectible tickets with a more elevated look — Premium is the rarest, with a glowing finish.',
    },
  ];

  function normalize(text) {
    return text.toLowerCase().trim();
  }

  function findBestMatch(userText) {
    const normalized = normalize(userText);
    const userWords = normalized.split(/\s+/).filter(w => w.length > 2);
    let best = null;
    let bestScore = 0;
    FAQ_DATABASE.forEach((entry) => {
      let score = 0;
      entry.keywords.forEach((kw) => {
        const kwLower = kw.toLowerCase();
        if (normalized.includes(kwLower)) {
          // Exact phrase match — strongest signal.
          score += kwLower.length;
        } else {
          // Partial credit: how many of this keyword's own words appear
          // anywhere in what the user typed (handles "buy a ticket" still
          // matching keyword "buy ticket" even with an extra word between).
          const kwWords = kwLower.split(/\s+/).filter(w => w.length > 2);
          const matchedWords = kwWords.filter(kwWord => userWords.includes(kwWord));
          if (matchedWords.length === kwWords.length && kwWords.length > 0) {
            score += kwLower.length * 0.8;
          }
        }
      });
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    });
    return bestScore >= 3 ? best : null;
  }

  // ---------------- UI ----------------
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #ecpChatBubble { position: fixed; bottom: 20px; right: 20px; width: 56px; height: 56px; border-radius: 50%;
        background: linear-gradient(135deg, #10b981, #059669); display: flex; align-items: center; justify-content: center;
        cursor: pointer; box-shadow: 0 8px 24px rgba(16,185,129,0.4); z-index: 9990; font-size: 22px; color: #fff;
        transition: transform 0.2s; }
      #ecpChatBubble:hover { transform: scale(1.08); }
      #ecpChatPanel { position: fixed; bottom: 88px; right: 20px; width: 340px; max-width: calc(100vw - 40px);
        height: 460px; max-height: calc(100vh - 140px); background: #131926; border: 1px solid #1e293b;
        border-radius: 16px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); z-index: 9991; display: none;
        flex-direction: column; overflow: hidden; font-family: 'Inter', Arial, sans-serif; }
      #ecpChatPanel.open { display: flex; }
      .ecp-chat-header { background: linear-gradient(135deg, #10b981, #059669); padding: 14px 16px; color: #fff;
        display: flex; align-items: center; justify-content: space-between; }
      .ecp-chat-header .title { font-weight: 800; font-size: 14px; }
      .ecp-chat-header .sub { font-size: 10px; opacity: 0.85; }
      .ecp-chat-close { cursor: pointer; font-size: 16px; opacity: 0.9; }
      .ecp-chat-body { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: #0b0f17; }
      .ecp-chat-msg { max-width: 85%; padding: 10px 13px; border-radius: 12px; font-size: 12.5px; line-height: 1.5; }
      .ecp-chat-msg.bot { align-self: flex-start; background: #1e293b; color: #e2e8f0; border-bottom-left-radius: 3px; }
      .ecp-chat-msg.user { align-self: flex-end; background: #10b981; color: #fff; border-bottom-right-radius: 3px; }
      .ecp-chat-suggestions { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
      .ecp-chat-suggestion-btn { background: #131926; border: 1px solid #1e293b; color: #94a3b8; font-size: 11px;
        padding: 8px 10px; border-radius: 8px; text-align: left; cursor: pointer; }
      .ecp-chat-suggestion-btn:hover { background: #1e293b; color: #fff; }
      .ecp-chat-input-row { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #1e293b; background: #131926; }
      .ecp-chat-input-row input { flex: 1; background: #0b0f17; border: 1px solid #1e293b; border-radius: 10px;
        padding: 10px 12px; color: #fff; font-size: 12.5px; }
      .ecp-chat-input-row button { background: #10b981; border: none; color: #fff; width: 38px; border-radius: 10px; cursor: pointer; }
      .ecp-chat-badge { position: absolute; top: -4px; right: -4px; background: #ef4444; color: #fff; font-size: 9px;
        font-weight: 800; min-width: 16px; height: 16px; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
    `;
    document.head.appendChild(style);
  }

  function injectWidget() {
    const bubble = document.createElement('div');
    bubble.id = 'ecpChatBubble';
    bubble.innerHTML = '<i class="fa-solid fa-comment-dots"></i>';
    bubble.onclick = togglePanel;
    document.body.appendChild(bubble);

    const panel = document.createElement('div');
    panel.id = 'ecpChatPanel';
    panel.innerHTML = `
      <div class="ecp-chat-header">
        <div>
          <div class="title"><i class="fa-solid fa-headset"></i> Support Assistant</div>
          <div class="sub">Instant answers, any time — even offline hours</div>
        </div>
        <div class="ecp-chat-close" onclick="document.getElementById('ecpChatPanel').classList.remove('open')"><i class="fa-solid fa-xmark"></i></div>
      </div>
      <div class="ecp-chat-body" id="ecpChatBody"></div>
      <div class="ecp-chat-input-row">
        <input type="text" id="ecpChatInput" placeholder="Ask a question..." onkeydown="if(event.key==='Enter') window.__ecpChatSend()">
        <button onclick="window.__ecpChatSend()"><i class="fa-solid fa-paper-plane"></i></button>
      </div>
    `;
    document.body.appendChild(panel);

    addBotMessage('Hi! I\'m the E-Codex Play support assistant. I can answer common questions right away — even if no staff are online right now. What do you need help with?');
    addSuggestions();
  }

  function togglePanel() {
    document.getElementById('ecpChatPanel').classList.toggle('open');
  }

  function addBotMessage(text) {
    const body = document.getElementById('ecpChatBody');
    const el = document.createElement('div');
    el.className = 'ecp-chat-msg bot';
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }

  function addUserMessage(text) {
    const body = document.getElementById('ecpChatBody');
    const el = document.createElement('div');
    el.className = 'ecp-chat-msg user';
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }

  function addSuggestions() {
    const body = document.getElementById('ecpChatBody');
    const wrap = document.createElement('div');
    wrap.className = 'ecp-chat-suggestions';
    const picks = FAQ_DATABASE.slice(0, 4);
    picks.forEach((entry) => {
      const btn = document.createElement('div');
      btn.className = 'ecp-chat-suggestion-btn';
      btn.textContent = entry.question;
      btn.onclick = () => handleUserQuestion(entry.question);
      wrap.appendChild(btn);
    });
    body.appendChild(wrap);
    body.scrollTop = body.scrollHeight;
  }

  async function handleUserQuestion(text) {
    if (!text.trim()) return;
    addUserMessage(text);
    const match = findBestMatch(text);
    await new Promise((r) => setTimeout(r, 400)); // small, natural-feeling pause
    if (match) {
      addBotMessage(match.answer);
    } else {
      addBotMessage('I don\'t have a ready answer for that one — I\'ve sent it to the E-Codex Play team through Support Messages. They\'ll get back to you as soon as they\'re available.');
      forwardToSupport(text);
    }
  }

  async function forwardToSupport(text) {
    try {
      await api.post('/shared/messages/my-thread', { body: `[From Support Assistant — unanswered question] ${text}` });
    } catch (e) { /* non-fatal — the chatbot conversation itself still helped */ }
  }

  window.__ecpChatSend = function () {
    const input = document.getElementById('ecpChatInput');
    const text = input.value;
    input.value = '';
    handleUserQuestion(text);
  };

  function init() {
    injectStyles();
    injectWidget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

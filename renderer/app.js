const state = {
  personas: [],
  activePersonaId: null,
  hasApiKey: true,
  messages: [],
  feedbackByQaId: {},
  replyTarget: null, // { messageId, quote }
  sending: false,
};

const els = {
  clock: document.getElementById('clock'),
  screenContacts: document.getElementById('screen-contacts'),
  screenThread: document.getElementById('screen-thread'),
  personaSwitcher: document.getElementById('persona-switcher'),
  contactList: document.getElementById('contact-list'),
  backBtn: document.getElementById('back-btn'),
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  composerInput: document.getElementById('composer-input'),
  composerSend: document.getElementById('composer-send'),
  replyBanner: document.getElementById('reply-banner'),
  replyBannerQuote: document.getElementById('reply-banner-quote'),
  replyCancel: document.getElementById('reply-cancel'),
  apiKeyBanner: document.getElementById('api-key-banner'),
};

function updateClock() {
  const now = new Date();
  let h = now.getHours();
  const m = String(now.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  els.clock.textContent = `${h}:${m} ${ampm}`;
}
updateClock();
setInterval(updateClock, 15000);

function activePersona() {
  return state.personas.find((p) => p.id === state.activePersonaId) || null;
}

function truncate(text, n) {
  if (!text) return '';
  return text.length > n ? text.slice(0, n - 1) + '…' : text;
}

function timeLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ---- Screens ----
function showContacts() {
  els.screenThread.classList.add('hidden');
  els.screenContacts.classList.remove('hidden');
  renderContactList();
}

function showThread() {
  els.screenContacts.classList.add('hidden');
  els.screenThread.classList.remove('hidden');
}

// ---- Persona switcher ----
function renderPersonaSwitcher() {
  els.personaSwitcher.innerHTML = '';
  for (const p of state.personas) {
    const btn = document.createElement('button');
    btn.className = 'persona-chip' + (p.id === state.activePersonaId ? ' active' : '');
    btn.textContent = p.name;
    btn.addEventListener('click', async () => {
      if (p.id === state.activePersonaId) return;
      await window.restoline.switchPersona(p.id);
      state.activePersonaId = p.id;
      renderPersonaSwitcher();
      renderContactList();
    });
    els.personaSwitcher.appendChild(btn);
  }
}

// ---- Contact list (single RestoLine contact) ----
async function renderContactList() {
  els.contactList.innerHTML = '';
  const { messages } = await window.restoline.getThread(state.activePersonaId);
  const last = messages[messages.length - 1];

  const row = document.createElement('div');
  row.className = 'contact-row';
  row.innerHTML = `
    <div class="avatar">R</div>
    <div class="contact-meta">
      <div class="contact-name-row">
        <span class="contact-name">RestoLine</span>
        <span class="contact-time">${last ? timeLabel(last.createdAt) : ''}</span>
      </div>
      <div class="contact-preview">${last ? escapeHtml(truncate(last.text, 42)) : 'No messages yet'}</div>
    </div>
  `;
  row.addEventListener('click', openThread);
  els.contactList.appendChild(row);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- Thread ----
async function openThread() {
  showThread();
  await loadThread();
}

async function loadThread() {
  const { messages, feedbackByQaId } = await window.restoline.getThread(state.activePersonaId);
  state.messages = messages;
  state.feedbackByQaId = feedbackByQaId;
  renderMessages();
}

function findMessageById(id) {
  return state.messages.find((m) => m.id === id) || null;
}

function feedbackForMessage(qaId, messageId) {
  const list = state.feedbackByQaId[qaId] || [];
  return list.find((f) => f.messageId === messageId) || null;
}

function sentimentEmoji(sentiment) {
  if (sentiment === 'positive') return '👍';
  if (sentiment === 'negative') return '👎';
  return '💬';
}

function renderMessages() {
  els.messages.innerHTML = '';

  for (const msg of state.messages) {
    const row = document.createElement('div');
    row.className = `bubble-row ${msg.sender}`;

    if (msg.replyToId) {
      const original = findMessageById(msg.replyToId);
      if (original) {
        const quote = document.createElement('div');
        quote.className = 'bubble-quote';
        quote.textContent = `↩ ${truncate(original.text, 50)}`;
        row.appendChild(quote);
      }
    }

    const wrap = document.createElement('div');
    wrap.className = 'bubble-wrap';

    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (msg.isFollowupPrompt ? ' followup' : '');
    bubble.textContent = msg.text;
    wrap.appendChild(bubble);

    const canReply = msg.sender === 'assistant' && !msg.isFollowupPrompt;
    const existingFeedback = canReply ? feedbackForMessage(msg.qaId, msg.id) : null;

    if (canReply && !existingFeedback) {
      const replyBtn = document.createElement('button');
      replyBtn.className = 'reply-icon-btn';
      replyBtn.title = 'Reply with feedback';
      replyBtn.innerHTML = '↩';
      replyBtn.addEventListener('click', () => startReply(msg));
      wrap.appendChild(replyBtn);
    }

    row.appendChild(wrap);

    if (msg.sender === 'assistant') {
      const captionParts = [];
      if (msg.usedWebSearch) captionParts.push('🔎 Searched the web for up-to-date info');
      if (msg.matchedContextCount) {
        captionParts.push(
          `Informed by ${msg.matchedContextCount} similar past question${msg.matchedContextCount > 1 ? 's' : ''}`
        );
      }
      if (captionParts.length) {
        const caption = document.createElement('div');
        caption.className = 'bubble-caption';
        caption.textContent = captionParts.join(' · ');
        row.appendChild(caption);
      }
    }

    if (existingFeedback) {
      const badge = document.createElement('div');
      badge.className = 'sentiment-badge';
      let text = `${sentimentEmoji(existingFeedback.sentiment)} Feedback recorded`;
      if (existingFeedback.correctedInfo) text += ` — noted a correction`;
      badge.textContent = text;
      row.appendChild(badge);
    }

    els.messages.appendChild(row);
  }

  els.messages.scrollTop = els.messages.scrollHeight;
}

function showTyping() {
  const row = document.createElement('div');
  row.className = 'bubble-row assistant typing-row';
  row.id = 'typing-row';
  row.innerHTML = `<div class="bubble-wrap"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
  els.messages.appendChild(row);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function hideTyping() {
  const row = document.getElementById('typing-row');
  if (row) row.remove();
}

function showErrorBubble(text) {
  const row = document.createElement('div');
  row.className = 'error-bubble';
  row.textContent = text;
  els.messages.appendChild(row);
  els.messages.scrollTop = els.messages.scrollHeight;
}

// ---- Reply-to-give-feedback flow ----
function startReply(msg) {
  state.replyTarget = { messageId: msg.id, quote: truncate(msg.text, 60) };
  els.replyBanner.classList.remove('hidden');
  els.replyBannerQuote.textContent = state.replyTarget.quote;
  els.composerInput.placeholder = 'Your feedback…';
  els.composerInput.focus();
}

function cancelReply() {
  state.replyTarget = null;
  els.replyBanner.classList.add('hidden');
  els.composerInput.placeholder = 'Text Message';
}

els.replyCancel.addEventListener('click', cancelReply);
els.backBtn.addEventListener('click', () => {
  cancelReply();
  showContacts();
});

// ---- Composer ----
els.composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.composerInput.value.trim();
  if (!text || state.sending) return;

  state.sending = true;
  els.composerSend.disabled = true;
  els.composerInput.value = '';

  const replyTarget = state.replyTarget;
  cancelReply();

  try {
    let result;
    if (replyTarget) {
      result = await window.restoline.sendFeedback(state.activePersonaId, replyTarget.messageId, text);
    } else {
      showTyping();
      result = await window.restoline.sendMessage(state.activePersonaId, text);
    }
    hideTyping();

    if (!result.ok) {
      showErrorBubble(result.error || 'Something went wrong.');
    } else {
      await loadThread();
    }
  } catch (err) {
    hideTyping();
    showErrorBubble(err.message || 'Something went wrong.');
  } finally {
    state.sending = false;
    els.composerSend.disabled = false;
  }
});

// ---- Boot ----
async function boot() {
  const init = await window.restoline.init();
  state.personas = init.personas;
  state.activePersonaId = init.activePersonaId;
  state.hasApiKey = init.hasApiKey;

  els.apiKeyBanner.classList.toggle('hidden', state.hasApiKey);

  renderPersonaSwitcher();
  showContacts();
}

boot();

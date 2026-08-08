const state = {
  personas: [],
  activePersonaId: null,
  hasApiKey: true,
  activeContact: null, // { id, name, initials, color, isPeer }
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
  threadAvatar: document.getElementById('thread-avatar'),
  threadName: document.getElementById('thread-name'),
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

function truncate(text, n) {
  if (!text) return '';
  return text.length > n ? text.slice(0, n - 1) + '…' : text;
}

function timeLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function personaName(personaId) {
  if (personaId === 'assistant') return 'RestoLine';
  const p = state.personas.find((x) => x.id === personaId);
  return p ? p.name : personaId;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

// ---- Contact list ----
async function renderContactList() {
  els.contactList.innerHTML = '';
  const contacts = await window.restoline.getContacts(state.activePersonaId);

  for (const contact of contacts) {
    const row = document.createElement('div');
    row.className = 'contact-row';
    const avatarStyle = contact.color ? ` style="background: ${contact.color}"` : '';
    row.innerHTML = `
      <div class="avatar"${avatarStyle}>${escapeHtml(contact.initials)}</div>
      <div class="contact-meta">
        <div class="contact-name-row">
          <span class="contact-name">${escapeHtml(contact.name)}</span>
          <span class="contact-time">${contact.lastMessageAt ? timeLabel(contact.lastMessageAt) : ''}</span>
        </div>
        <div class="contact-preview">${contact.lastMessage ? escapeHtml(truncate(contact.lastMessage, 42)) : 'No messages yet'}</div>
      </div>
    `;
    row.addEventListener('click', () => openThread(contact));
    els.contactList.appendChild(row);
  }
}

// ---- Thread ----
async function openThread(contact) {
  state.activeContact = contact;
  els.threadAvatar.textContent = contact.initials;
  els.threadAvatar.style.background = contact.color || '';
  els.threadName.textContent = contact.name;
  showThread();
  await loadThread();
}

async function loadThread() {
  const { messages, feedbackByQaId } = await window.restoline.getThread(state.activePersonaId, state.activeContact.id);
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
  const isPeerThread = state.activeContact.isPeer;

  for (const msg of state.messages) {
    // In the RestoLine thread, sender is literally 'user'/'assistant'. In a
    // peer thread, sender is whichever persona typed it — compare against
    // the persona currently "driving" the app to pick a side of the thread.
    const mine = msg.sender === 'user' || msg.sender === state.activePersonaId;

    const row = document.createElement('div');
    row.className = `bubble-row ${mine ? 'user' : 'assistant'}`;

    if (isPeerThread && !mine) {
      const label = document.createElement('div');
      label.className = 'bubble-sender-label';
      label.textContent = personaName(msg.sender);
      row.appendChild(label);
    }

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
    bubble.className = 'bubble' + (msg.isFollowupPrompt || msg.isPeerOffer ? ' followup' : '');
    bubble.textContent = msg.text;
    wrap.appendChild(bubble);

    const canReply = !isPeerThread && msg.sender === 'assistant' && !msg.isFollowupPrompt && !msg.isPeerOffer;
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

    if (!isPeerThread && msg.sender === 'assistant') {
      const captionParts = [];
      if (msg.usedWebSearch) captionParts.push('🔎 Searched the web for up-to-date info');
      if (msg.matchedContextCount) {
        captionParts.push(
          `Informed by ${msg.matchedContextCount} similar past question${msg.matchedContextCount > 1 ? 's' : ''}`
        );
      }
      if (msg.isPeerOffer) captionParts.push('💡 Peer connection offer');
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
      result = await window.restoline.sendMessage(state.activePersonaId, state.activeContact.id, text);
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

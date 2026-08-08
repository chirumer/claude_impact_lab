// Lightweight JSON-file datastore. No native deps (avoids node-gyp headaches),
// fine at hackathon scale (hundreds of messages).
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'app.json');

const RESTOLINE_CONTACT_ID = 'restoline';

const SEED_PERSONAS = [
  { id: 'you', name: 'You', initials: 'Y', color: '#0a84ff' },
  { id: 'alex', name: 'Alex', initials: 'A', color: '#ff9f0a' },
  { id: 'sam', name: 'Sam', initials: 'S', color: '#30d158' },
];

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function minutesAgo(mins) {
  return new Date(Date.now() - mins * 60000).toISOString();
}

// Seed a bit of "other users'" history (with feedback already attached) so the
// similarity-context feature has something to match against from first launch.
function seedHistory(data) {
  const entries = [
    {
      personaId: 'alex',
      minsAgo: 60 * 26,
      question: "What are RestoLine's support hours?",
      answer: 'RestoLine is available 24/7 to help with your questions, any time of day or night.',
      feedbackText: "Yep that's right, thanks!",
    },
    {
      personaId: 'sam',
      minsAgo: 60 * 20,
      question: 'How many days do I have to request a refund?',
      answer: 'You generally have 14 days from your purchase date to request a refund.',
      feedbackText:
        "Actually it's 30 days, not 14 — the policy changed last month. Please get that right next time.",
    },
    {
      personaId: 'alex',
      minsAgo: 60 * 5,
      question: "What's the current wait time to reach a live agent?",
      answer: "I don't have real-time data on current wait times, so I can't say for sure.",
      feedbackText:
        'You should actually look this up live instead of guessing — check the live status page or search for it.',
    },
  ];

  for (const entry of entries) {
    const qId = genId('msg');
    const aId = genId('msg');
    const qaId = genId('qa');
    const createdAt = minutesAgo(entry.minsAgo);

    data.messages.push({
      id: qId,
      personaId: entry.personaId,
      contactId: RESTOLINE_CONTACT_ID,
      sender: 'user',
      text: entry.question,
      replyToId: null,
      qaId,
      isFollowupPrompt: false,
      isPeerOffer: false,
      createdAt,
    });
    data.messages.push({
      id: aId,
      personaId: entry.personaId,
      contactId: RESTOLINE_CONTACT_ID,
      sender: 'assistant',
      text: entry.answer,
      replyToId: null,
      qaId,
      isFollowupPrompt: false,
      isPeerOffer: false,
      usedWebSearch: false,
      createdAt: minutesAgo(entry.minsAgo - 1),
    });

    data.qaRecords.push({
      id: qaId,
      personaId: entry.personaId,
      questionMessageId: qId,
      answerMessageId: aId,
      questionText: entry.question,
      answerText: entry.answer,
      questionEmbedding: null, // computed lazily on first app launch
      usedWebSearch: false,
      requiresTool: 'none',
      pendingFollowup: false,
      peerOffer: null,
      createdAt,
    });

    // Feedback is analyzed lazily too (needs a Claude call), see main.js seedAnalysis step.
    data.feedback.push({
      id: genId('fb'),
      qaId,
      personaId: entry.personaId,
      messageId: aId,
      text: entry.feedbackText,
      analyzed: false,
      sentiment: null,
      correctedInfo: null,
      needsFollowup: false,
      followupQuestion: null,
      requiresTool: null,
      toolReason: null,
      createdAt: minutesAgo(entry.minsAgo - 2),
    });
  }
}

function defaultData() {
  const data = {
    personas: SEED_PERSONAS,
    activePersonaId: 'you',
    messages: [],
    qaRecords: [],
    feedback: [],
    connections: [],
  };
  seedHistory(data);
  return data;
}

let cache = null;

function load() {
  if (cache) return cache;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    cache = defaultData();
    persist();
    return cache;
  }
  try {
    cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!cache.connections) cache.connections = [];
  } catch (err) {
    console.error('Failed to read data file, reseeding.', err);
    cache = defaultData();
    persist();
  }
  return cache;
}

function persist() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
}

// ---- Personas ----
function getPersonas() {
  return load().personas;
}

function getPersona(id) {
  return load().personas.find((p) => p.id === id) || null;
}

function getActivePersonaId() {
  return load().activePersonaId;
}

function setActivePersonaId(id) {
  const data = load();
  data.activePersonaId = id;
  persist();
}

// ---- Contacts ----
// The RestoLine bot contact, plus one contact per accepted peer connection.
function getContactsForPersona(personaId) {
  const restoline = { id: RESTOLINE_CONTACT_ID, name: 'RestoLine', initials: 'R', color: null, isPeer: false };
  const peers = getConnectionsForPersona(personaId).map((c) => {
    const otherId = c.personaAId === personaId ? c.personaBId : c.personaAId;
    const other = getPersona(otherId);
    return {
      id: c.id,
      name: other ? other.name : 'Unknown',
      initials: other ? other.initials : '?',
      color: other ? other.color : '#8e8e93',
      isPeer: true,
    };
  });
  return [restoline, ...peers];
}

// ---- Messages ----
// RestoLine threads are private per persona; connection threads are shared
// between the two connected personas (same contactId, no personaId filter).
function getThreadMessages(personaId, contactId) {
  const messages = load().messages;
  if (contactId === RESTOLINE_CONTACT_ID) {
    return messages.filter((m) => m.personaId === personaId && (m.contactId || RESTOLINE_CONTACT_ID) === RESTOLINE_CONTACT_ID);
  }
  return messages.filter((m) => m.contactId === contactId);
}

function getMessageById(id) {
  return load().messages.find((m) => m.id === id) || null;
}

function addMessage({
  personaId,
  contactId = RESTOLINE_CONTACT_ID,
  sender,
  text,
  replyToId = null,
  qaId = null,
  isFollowupPrompt = false,
  isPeerOffer = false,
  usedWebSearch = false,
  matchedContextCount = 0,
}) {
  const data = load();
  const message = {
    id: genId('msg'),
    personaId,
    contactId,
    sender,
    text,
    replyToId,
    qaId,
    isFollowupPrompt,
    isPeerOffer,
    usedWebSearch,
    matchedContextCount,
    createdAt: new Date().toISOString(),
  };
  data.messages.push(message);
  persist();
  return message;
}

// ---- QA records ----
function createQaRecord({ personaId, questionMessageId, answerMessageId, questionText, answerText, questionEmbedding, usedWebSearch = false }) {
  const data = load();
  const record = {
    id: genId('qa'),
    personaId,
    questionMessageId,
    answerMessageId,
    questionText,
    answerText,
    questionEmbedding,
    usedWebSearch,
    requiresTool: 'none',
    pendingFollowup: false,
    peerOffer: null,
    createdAt: new Date().toISOString(),
  };
  data.qaRecords.push(record);
  persist();
  return record;
}

function getQaRecord(id) {
  return load().qaRecords.find((q) => q.id === id) || null;
}

function getAllQaRecords() {
  return load().qaRecords;
}

function updateQaRecord(id, patch) {
  const data = load();
  const record = data.qaRecords.find((q) => q.id === id);
  if (!record) return null;
  Object.assign(record, patch);
  persist();
  return record;
}

// Records that have at least one feedback entry attached (from ANY persona),
// used as the pool for similarity matching. Excludes a given persona optionally.
function getQaRecordsWithFeedback() {
  const data = load();
  const qaIdsWithFeedback = new Set(data.feedback.map((f) => f.qaId));
  return data.qaRecords.filter((q) => qaIdsWithFeedback.has(q.id) && q.questionEmbedding);
}

// All embedded questions from OTHER personas — the pool for "someone else is
// going through the same thing" peer matching (feedback not required here).
function getQaRecordsFromOtherPersonas(personaId) {
  return load().qaRecords.filter((q) => q.personaId !== personaId && q.questionEmbedding);
}

function getAllQaRecordsMissingEmbedding() {
  return load().qaRecords.filter((q) => !q.questionEmbedding);
}

// Has this persona already been offered a connection to this specific peer
// persona before (regardless of outcome)? Prevents repeat offers every turn.
function hasPeerOfferBeenMadeFor(personaId, peerPersonaId) {
  return load().qaRecords.some(
    (q) => q.personaId === personaId && q.peerOffer && q.peerOffer.personaId === peerPersonaId
  );
}

function findPendingPeerOfferQa(personaId) {
  return (
    load()
      .qaRecords.filter((q) => q.personaId === personaId && q.peerOffer && q.peerOffer.status === 'pending')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null
  );
}

// ---- Connections (peer-to-peer threads between two personas) ----
function getConnectionsForPersona(personaId) {
  return load().connections.filter((c) => c.personaAId === personaId || c.personaBId === personaId);
}

function getConnectionBetween(personaAId, personaBId) {
  return (
    load().connections.find(
      (c) =>
        (c.personaAId === personaAId && c.personaBId === personaBId) ||
        (c.personaAId === personaBId && c.personaBId === personaAId)
    ) || null
  );
}

function getConnection(id) {
  return load().connections.find((c) => c.id === id) || null;
}

function createConnection({ personaAId, personaBId }) {
  const existing = getConnectionBetween(personaAId, personaBId);
  if (existing) return existing;
  const data = load();
  const connection = { id: genId('conn'), personaAId, personaBId, createdAt: new Date().toISOString() };
  data.connections.push(connection);
  persist();
  return connection;
}

// ---- Feedback ----
function addFeedback({ qaId, personaId, messageId, text, analysis }) {
  const data = load();
  const record = {
    id: genId('fb'),
    qaId,
    personaId,
    messageId,
    text,
    analyzed: true,
    sentiment: analysis.sentiment,
    correctedInfo: analysis.correctedInfo || null,
    needsFollowup: !!analysis.needsFollowup,
    followupQuestion: analysis.followupQuestion || null,
    requiresTool: analysis.requiresTool || 'none',
    toolReason: analysis.toolReason || null,
    createdAt: new Date().toISOString(),
  };
  data.feedback.push(record);
  persist();
  return record;
}

function getFeedbackForQa(qaId) {
  return load().feedback.filter((f) => f.qaId === qaId);
}

function getUnanalyzedFeedback() {
  return load().feedback.filter((f) => !f.analyzed);
}

function markFeedbackAnalyzed(id, analysis) {
  const data = load();
  const fb = data.feedback.find((f) => f.id === id);
  if (!fb) return null;
  Object.assign(fb, {
    analyzed: true,
    sentiment: analysis.sentiment,
    correctedInfo: analysis.correctedInfo || null,
    needsFollowup: !!analysis.needsFollowup,
    followupQuestion: analysis.followupQuestion || null,
    requiresTool: analysis.requiresTool || 'none',
    toolReason: analysis.toolReason || null,
  });
  persist();
  return fb;
}

module.exports = {
  RESTOLINE_CONTACT_ID,
  load,
  persist,
  getPersonas,
  getPersona,
  getActivePersonaId,
  setActivePersonaId,
  getContactsForPersona,
  getThreadMessages,
  getMessageById,
  addMessage,
  createQaRecord,
  getQaRecord,
  getAllQaRecords,
  updateQaRecord,
  getQaRecordsWithFeedback,
  getQaRecordsFromOtherPersonas,
  getAllQaRecordsMissingEmbedding,
  hasPeerOfferBeenMadeFor,
  findPendingPeerOfferQa,
  getConnectionsForPersona,
  getConnectionBetween,
  getConnection,
  createConnection,
  addFeedback,
  getFeedbackForQa,
  getUnanalyzedFeedback,
  markFeedbackAnalyzed,
};

// Lightweight JSON-file datastore. No native deps (avoids node-gyp headaches),
// fine at hackathon scale (hundreds of messages).
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'app.json');

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
      sender: 'user',
      text: entry.question,
      replyToId: null,
      qaId,
      isFollowupPrompt: false,
      createdAt,
    });
    data.messages.push({
      id: aId,
      personaId: entry.personaId,
      sender: 'assistant',
      text: entry.answer,
      replyToId: null,
      qaId,
      isFollowupPrompt: false,
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

function getActivePersonaId() {
  return load().activePersonaId;
}

function setActivePersonaId(id) {
  const data = load();
  data.activePersonaId = id;
  persist();
}

// ---- Messages ----
function getMessages(personaId) {
  return load().messages.filter((m) => m.personaId === personaId);
}

function getMessageById(id) {
  return load().messages.find((m) => m.id === id) || null;
}

function addMessage({ personaId, sender, text, replyToId = null, qaId = null, isFollowupPrompt = false, usedWebSearch = false, matchedContextCount = 0 }) {
  const data = load();
  const message = {
    id: genId('msg'),
    personaId,
    sender,
    text,
    replyToId,
    qaId,
    isFollowupPrompt,
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
    createdAt: new Date().toISOString(),
  };
  data.qaRecords.push(record);
  persist();
  return record;
}

function getQaRecord(id) {
  return load().qaRecords.find((q) => q.id === id) || null;
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

function getAllQaRecordsMissingEmbedding() {
  return load().qaRecords.filter((q) => !q.questionEmbedding);
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
  load,
  persist,
  getPersonas,
  getActivePersonaId,
  setActivePersonaId,
  getMessages,
  getMessageById,
  addMessage,
  createQaRecord,
  getQaRecord,
  updateQaRecord,
  getQaRecordsWithFeedback,
  getAllQaRecordsMissingEmbedding,
  addFeedback,
  getFeedbackForQa,
  getUnanalyzedFeedback,
  markFeedbackAnalyzed,
};

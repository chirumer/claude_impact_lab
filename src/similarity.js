const store = require('./store');

const DEFAULT_THRESHOLD = Number(process.env.SIMILARITY_THRESHOLD) || 0.75;
const MAX_MATCHES = 3;
// Peer-connection matches need to be a much closer topical match than the
// "informs my answer" context threshold above — this is "the same problem,"
// not just "a related question."
const PEER_THRESHOLD = Number(process.env.PEER_SIMILARITY_THRESHOLD) || 0.85;

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Finds past questions (asked by anyone) that already have user feedback attached,
// and are semantically similar to the new question. This is the "shared learning"
// pool RestoLine draws on before answering a new question.
function findSimilarFeedbackQuestions(questionEmbedding, { excludeQaId = null } = {}) {
  const candidates = store.getQaRecordsWithFeedback().filter((q) => q.id !== excludeQaId);

  const scored = candidates
    .map((qa) => ({ qa, score: cosineSimilarity(questionEmbedding, qa.questionEmbedding) }))
    .filter((entry) => entry.score >= DEFAULT_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES);

  return scored.map(({ qa, score }) => {
    const feedback = store.getFeedbackForQa(qa.id);
    return { qa, score, feedback };
  });
}

function buildContextBlock(matches) {
  if (!matches.length) return { contextBlock: '', useWebSearch: false };

  let useWebSearch = false;
  const lines = matches.map(({ qa, feedback, score }, i) => {
    const parts = [`(${i + 1}) Q: ${qa.questionText}`, `   A given: ${qa.answerText}`];
    for (const fb of feedback) {
      if (fb.sentiment) parts.push(`   Feedback (${fb.sentiment}): ${fb.text}`);
      if (fb.correctedInfo) parts.push(`   Correction to apply: ${fb.correctedInfo}`);
      if (fb.requiresTool === 'web_search') {
        useWebSearch = true;
        parts.push(`   Note: this type of question needs live web search, not a memorized answer.`);
      }
    }
    return parts.join('\n');
  });

  const contextBlock = `Context from similar past questions asked by other users (with their feedback on the previous answers):\n${lines.join('\n\n')}`;
  return { contextBlock, useWebSearch };
}

// Finds the single best match from OTHER personas asking essentially the same
// question, so RestoLine can offer to connect the two people. `excludePersonaIds`
// filters out peers who've already been offered a connection to this persona.
function findPeerMatch(questionEmbedding, currentPersonaId, { excludePersonaIds = [] } = {}) {
  const excluded = new Set(excludePersonaIds);
  const candidates = store
    .getQaRecordsFromOtherPersonas(currentPersonaId)
    .filter((qa) => !excluded.has(qa.personaId));

  let best = null;
  for (const qa of candidates) {
    const score = cosineSimilarity(questionEmbedding, qa.questionEmbedding);
    if (score >= PEER_THRESHOLD && (!best || score > best.score)) {
      best = { qa, score };
    }
  }
  return best;
}

module.exports = {
  cosineSimilarity,
  findSimilarFeedbackQuestions,
  buildContextBlock,
  findPeerMatch,
  DEFAULT_THRESHOLD,
  PEER_THRESHOLD,
};

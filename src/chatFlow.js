const store = require('./store');
const ai = require('./ai');
const { findSimilarFeedbackQuestions, buildContextBlock, findPeerMatch } = require('./similarity');

// Embeddings are a nice-to-have (cross-user context), not required to answer.
// If Voyage is unconfigured or erroring, log it once and fall through to
// answering with no similarity context rather than blocking the reply.
let warnedEmbeddingUnavailable = false;
async function tryEmbed(text) {
  try {
    return await ai.embedText(text);
  } catch (err) {
    if (!warnedEmbeddingUnavailable) {
      console.warn('Embeddings unavailable, answering without similarity context:', err.message);
      warnedEmbeddingUnavailable = true;
    }
    return null;
  }
}

// One-time (idempotent) startup pass: compute embeddings for any seeded/past
// questions that don't have one yet, and run feedback analysis for any
// feedback that hasn't been analyzed yet. Safe to call on every launch.
async function seedIfNeeded() {
  if (!ai.hasApiKey()) return;

  for (const qa of store.getAllQaRecordsMissingEmbedding()) {
    const embedding = await tryEmbed(qa.questionText);
    if (embedding) store.updateQaRecord(qa.id, { questionEmbedding: embedding });
  }

  for (const fb of store.getUnanalyzedFeedback()) {
    const qa = store.getQaRecord(fb.qaId);
    if (!qa) continue;
    try {
      const analysis = await ai.analyzeFeedback({
        question: qa.questionText,
        answer: qa.answerText,
        feedbackText: fb.text,
      });
      store.markFeedbackAnalyzed(fb.id, analysis);
      if (analysis.requiresTool === 'web_search') {
        store.updateQaRecord(qa.id, { requiresTool: 'web_search' });
      }
    } catch (err) {
      console.error('Seed feedback analysis failed for', fb.id, err.message);
    }
  }
}

function findPendingFollowupQa(personaId) {
  const data = store.load();
  return (
    data.qaRecords
      .filter((q) => q.personaId === personaId && q.pendingFollowup)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null
  );
}

// Routes an incoming message to the right thread: the RestoLine bot, or a
// peer-to-peer connection thread with another persona.
async function sendMessage(personaId, contactId, text) {
  if (contactId === store.RESTOLINE_CONTACT_ID) {
    return sendRestolineMessage(personaId, text);
  }
  return sendConnectionMessage(personaId, contactId, text);
}

async function sendRestolineMessage(personaId, text) {
  const userMsg = store.addMessage({ personaId, contactId: store.RESTOLINE_CONTACT_ID, sender: 'user', text });

  const peerOfferQa = store.findPendingPeerOfferQa(personaId);
  if (peerOfferQa) {
    await respondToPeerOffer(personaId, peerOfferQa, text);
    return { ok: true };
  }

  const pendingQa = findPendingFollowupQa(personaId);
  if (pendingQa) {
    await continueWithFollowupAnswer(personaId, pendingQa, text);
  } else {
    await askNewQuestion(personaId, userMsg, text);
  }
  return { ok: true };
}

async function askNewQuestion(personaId, userMsg, text) {
  const embedding = await tryEmbed(text);
  const matches = embedding ? findSimilarFeedbackQuestions(embedding) : [];
  const { contextBlock, useWebSearch } = buildContextBlock(matches);

  const answer = await ai.generateReply({ question: text, contextBlock, useWebSearch });

  const qa = store.createQaRecord({
    personaId,
    questionMessageId: userMsg.id,
    answerMessageId: null,
    questionText: text,
    answerText: answer,
    questionEmbedding: embedding,
    usedWebSearch: useWebSearch,
  });

  const assistantMsg = store.addMessage({
    personaId,
    contactId: store.RESTOLINE_CONTACT_ID,
    sender: 'assistant',
    text: answer,
    qaId: qa.id,
    usedWebSearch: useWebSearch,
    matchedContextCount: matches.length,
  });
  store.updateQaRecord(qa.id, { answerMessageId: assistantMsg.id });

  if (embedding) await maybeOfferPeerConnection(personaId, qa, embedding);
}

// If someone else asked essentially the same question, offer to connect the
// two people directly — they're going through the same thing.
async function maybeOfferPeerConnection(personaId, qa, embedding) {
  const alreadyConnectedTo = new Set(
    store.getConnectionsForPersona(personaId).map((c) => (c.personaAId === personaId ? c.personaBId : c.personaAId))
  );
  const alreadyOfferedTo = store
    .getAllQaRecords()
    .filter((q) => q.personaId === personaId && q.peerOffer)
    .map((q) => q.peerOffer.personaId);
  const exclude = new Set([...alreadyConnectedTo, ...alreadyOfferedTo]);

  const match = findPeerMatch(embedding, personaId, { excludePersonaIds: [...exclude] });
  if (!match) return;

  const peer = store.getPersona(match.qa.personaId);
  if (!peer) return;

  store.updateQaRecord(qa.id, {
    peerOffer: { personaId: peer.id, personaName: peer.name, theirQaId: match.qa.id, status: 'pending' },
  });

  store.addMessage({
    personaId,
    contactId: store.RESTOLINE_CONTACT_ID,
    sender: 'assistant',
    text: `By the way — ${peer.name} asked something really similar recently. Want me to connect you two so you can talk directly?`,
    qaId: qa.id,
    isPeerOffer: true,
  });
}

async function respondToPeerOffer(personaId, qa, replyText) {
  const offer = qa.peerOffer;
  const accepted = await ai.interpretYesNo(replyText);

  if (accepted) {
    const connection = store.createConnection({ personaAId: personaId, personaBId: offer.personaId });
    store.updateQaRecord(qa.id, { peerOffer: { ...offer, status: 'accepted' } });

    store.addMessage({
      personaId,
      contactId: store.RESTOLINE_CONTACT_ID,
      sender: 'assistant',
      text: `Connected! You'll now see ${offer.personaName} in your contacts — say hi.`,
      qaId: qa.id,
    });

    store.addMessage({
      personaId,
      contactId: connection.id,
      sender: 'assistant',
      text: `RestoLine connected you two because you were both dealing with something similar. Say hi!`,
    });
  } else {
    store.updateQaRecord(qa.id, { peerOffer: { ...offer, status: 'declined' } });
    store.addMessage({
      personaId,
      contactId: store.RESTOLINE_CONTACT_ID,
      sender: 'assistant',
      text: 'No worries — let me know if you change your mind.',
      qaId: qa.id,
    });
  }
}

async function continueWithFollowupAnswer(personaId, qa, followupAnswerText) {
  const feedbackEntries = store.getFeedbackForQa(qa.id);
  const latestFeedback = feedbackEntries[feedbackEntries.length - 1];

  const refinePrompt = [
    `Original question: ${qa.questionText}`,
    `Your previous answer: ${qa.answerText}`,
    latestFeedback ? `The user's feedback on that answer: ${latestFeedback.text}` : null,
    latestFeedback && latestFeedback.followupQuestion
      ? `You asked this clarifying question: ${latestFeedback.followupQuestion}`
      : null,
    `The user's clarifying reply: ${followupAnswerText}`,
    '',
    'Now give a corrected, final answer to the original question, incorporating everything above. Reply as if continuing the text conversation (do not repeat the original question back).',
  ]
    .filter(Boolean)
    .join('\n');

  const useWebSearch = qa.requiresTool === 'web_search';
  const refinedAnswer = await ai.generateReply({ question: refinePrompt, contextBlock: '', useWebSearch });

  store.addMessage({
    personaId,
    contactId: store.RESTOLINE_CONTACT_ID,
    sender: 'assistant',
    text: refinedAnswer,
    qaId: qa.id,
    usedWebSearch: useWebSearch,
  });
  store.updateQaRecord(qa.id, { answerText: refinedAnswer, pendingFollowup: false });
}

// Peer-to-peer messages are a plain relay between the two connected personas —
// no AI involved. The "other side" of the conversation is whoever the user
// switches personas to.
async function sendConnectionMessage(personaId, connectionId, text) {
  const connection = store.getConnection(connectionId);
  if (!connection || (connection.personaAId !== personaId && connection.personaBId !== personaId)) {
    return { ok: false, error: 'Connection not found.' };
  }
  store.addMessage({ personaId, contactId: connectionId, sender: personaId, text });
  return { ok: true };
}

async function sendFeedback(personaId, messageId, feedbackText) {
  const message = store.getMessageById(messageId);
  if (!message || message.sender !== 'assistant' || !message.qaId) {
    return { ok: false, error: 'Can only give feedback on a RestoLine reply.' };
  }
  const qa = store.getQaRecord(message.qaId);
  if (!qa) return { ok: false, error: 'Original question not found.' };

  store.addMessage({
    personaId,
    contactId: store.RESTOLINE_CONTACT_ID,
    sender: 'user',
    text: feedbackText,
    replyToId: messageId,
    qaId: qa.id,
  });

  const analysis = await ai.analyzeFeedback({
    question: qa.questionText,
    answer: qa.answerText,
    feedbackText,
  });
  store.addFeedback({ qaId: qa.id, personaId, messageId, text: feedbackText, analysis });

  if (analysis.requiresTool === 'web_search') {
    store.updateQaRecord(qa.id, { requiresTool: 'web_search' });
  }

  if (analysis.needsFollowup && analysis.followupQuestion) {
    store.updateQaRecord(qa.id, { pendingFollowup: true });
    store.addMessage({
      personaId,
      contactId: store.RESTOLINE_CONTACT_ID,
      sender: 'assistant',
      text: analysis.followupQuestion,
      qaId: qa.id,
      isFollowupPrompt: true,
    });
  }

  return { ok: true };
}

module.exports = { seedIfNeeded, sendMessage, sendFeedback };

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const CHAT_MODEL = process.env.CLAUDE_CHAT_MODEL || 'claude-haiku-4-5';
const VOYAGE_MODEL = process.env.VOYAGE_EMBEDDING_MODEL || 'voyage-4-lite';
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

let client = null;
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.');
  }
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

function hasApiKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function friendlyError(err) {
  if (err instanceof Anthropic.APIError) {
    return new Error(`${err.message} (status ${err.status})`);
  }
  return err;
}

const SYSTEM_INSTRUCTION = `You are RestoLine, a helpful AI assistant reachable over text message, like a texting-based support line.
Keep replies short and conversational (this is a text message thread, not an essay) — a few sentences at most unless the user asks for detail.
If you are given a "Context from similar past questions" block, use it to inform your answer (it may include corrections other users already gave, or notes on what earlier answers got wrong) — but never mention the internal mechanics of that context to the user, just answer well.`;

async function generateReply({ question, contextBlock, useWebSearch }) {
  const ai = getClient();
  const contents = contextBlock ? `${contextBlock}\n\nUser's new question: ${question}` : question;

  const params = {
    model: CHAT_MODEL,
    max_tokens: 1024,
    system: SYSTEM_INSTRUCTION,
    messages: [{ role: 'user', content: contents }],
  };
  if (useWebSearch) {
    params.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  try {
    const response = await ai.messages.create(params);
    const textBlock = response.content.find((b) => b.type === 'text');
    return (textBlock ? textBlock.text : '').trim();
  } catch (err) {
    throw friendlyError(err);
  }
}

async function embedText(text) {
  const apiKey = process.env.VOYAGEAI_API_KEY;
  if (!apiKey) {
    throw new Error('VOYAGEAI_API_KEY is not set. Copy .env.example to .env and add your key.');
  }
  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: [text], model: VOYAGE_MODEL, input_type: 'document' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage embeddings request failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

const FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
    correctedInfo: { type: ['string', 'null'] },
    needsFollowup: { type: 'boolean' },
    followupQuestion: { type: ['string', 'null'] },
    requiresTool: { type: 'string', enum: ['web_search', 'none'] },
    toolReason: { type: ['string', 'null'] },
  },
  required: ['sentiment', 'correctedInfo', 'needsFollowup', 'followupQuestion', 'requiresTool', 'toolReason'],
  additionalProperties: false,
};

async function analyzeFeedback({ question, answer, feedbackText }) {
  const ai = getClient();
  const prompt = `You are analyzing a user's feedback on RestoLine's (an AI assistant's) reply, so future answers to similar questions from OTHER users can be improved.

Original question: ${question}
RestoLine's answer: ${answer}
User's feedback (sent by replying to RestoLine's message): ${feedbackText}

Decide:
1. sentiment: was the feedback positive, negative, or neutral about the answer?
2. correctedInfo: if the feedback corrects a factual error in the answer, summarize the correct information in one sentence. Null if there's no correction.
3. needsFollowup: true ONLY if RestoLine should immediately ask the user a clarifying question to gather more context before this feedback is actionable (e.g. it's vague, or references something unclear). False if the feedback already stands on its own.
4. followupQuestion: if needsFollowup is true, the single clarifying question RestoLine should send back. Null otherwise.
5. requiresTool: "web_search" if correctly answering THIS TYPE of question requires real-time / current information a language model can't know from training (current status, live wait times, today's prices, etc). Otherwise "none".
6. toolReason: one short sentence justifying requiresTool, or null if "none".`;

  try {
    const response = await ai.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
      output_config: {
        format: { type: 'json_schema', schema: FEEDBACK_SCHEMA },
      },
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    return JSON.parse(textBlock.text);
  } catch (err) {
    throw friendlyError(err);
  }
}

module.exports = {
  generateReply,
  embedText,
  analyzeFeedback,
  hasApiKey,
  CHAT_MODEL,
  VOYAGE_MODEL,
};

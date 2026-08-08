require('dotenv').config();
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const store = require('./src/store');
const ai = require('./src/ai');
const chatFlow = require('./src/chatFlow');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 390,
    height: 844,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Messages',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  createWindow();
  try {
    await chatFlow.seedIfNeeded();
  } catch (err) {
    console.error('Seeding failed:', err);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---- IPC ----
ipcMain.handle('app:init', () => ({
  personas: store.getPersonas(),
  activePersonaId: store.getActivePersonaId(),
  hasApiKey: ai.hasApiKey(),
}));

ipcMain.handle('persona:switch', (event, personaId) => {
  store.setActivePersonaId(personaId);
  return { ok: true };
});

ipcMain.handle('thread:get', (event, personaId) => {
  const messages = [...store.getMessages(personaId)].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );
  const feedbackByQaId = {};
  for (const m of messages) {
    if (m.qaId && !feedbackByQaId[m.qaId]) {
      feedbackByQaId[m.qaId] = store.getFeedbackForQa(m.qaId);
    }
  }
  return { messages, feedbackByQaId };
});

ipcMain.handle('chat:send', async (event, { personaId, text }) => {
  try {
    return await chatFlow.sendMessage(personaId, text);
  } catch (err) {
    console.error(err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('chat:feedback', async (event, { personaId, messageId, feedbackText }) => {
  try {
    return await chatFlow.sendFeedback(personaId, messageId, feedbackText);
  } catch (err) {
    console.error(err);
    return { ok: false, error: err.message };
  }
});

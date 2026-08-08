const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('restoline', {
  init: () => ipcRenderer.invoke('app:init'),
  switchPersona: (personaId) => ipcRenderer.invoke('persona:switch', personaId),
  getThread: (personaId) => ipcRenderer.invoke('thread:get', personaId),
  sendMessage: (personaId, text) => ipcRenderer.invoke('chat:send', { personaId, text }),
  sendFeedback: (personaId, messageId, feedbackText) =>
    ipcRenderer.invoke('chat:feedback', { personaId, messageId, feedbackText }),
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('restoline', {
  init: () => ipcRenderer.invoke('app:init'),
  switchPersona: (personaId) => ipcRenderer.invoke('persona:switch', personaId),
  getContacts: (personaId) => ipcRenderer.invoke('contacts:get', personaId),
  getThread: (personaId, contactId) => ipcRenderer.invoke('thread:get', { personaId, contactId }),
  sendMessage: (personaId, contactId, text) => ipcRenderer.invoke('chat:send', { personaId, contactId, text }),
  sendFeedback: (personaId, messageId, feedbackText) =>
    ipcRenderer.invoke('chat:feedback', { personaId, messageId, feedbackText }),
});

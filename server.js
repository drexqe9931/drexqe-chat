const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7
});

app.use(express.static(path.join(__dirname, 'public')));

const chatHistory = [];
const bannedUsers = new Set();
const bannedDevices = new Set();
const userWarnings = new Map();

const MEMBER_PASSKEY = '9460';
const ADMIN_PASSKEY = 'M4nil@l019';

const badWordsList = [
  'mc', 'bc', 'madarchod', 'bhenchod', 'gand', 'gandu',
  'chutiya', 'bsdk', 'bhosdike', 'harami', 'lauda', 'lodu'
];

function containsBadWords(text) {
  if (!text || typeof text !== 'string') return false;
  const cleanText = text.toLowerCase().replace(/[^a-z0-9\s]/gi, '');
  const words = cleanText.split(/\s+/);
  return badWordsList.some(badWord => words.includes(badWord) || cleanText.includes(badWord));
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, user, role, passkey, deviceId }) => {
    if (bannedUsers.has(user) || bannedDevices.has(deviceId)) {
      socket.emit('auth-error', 'You are banned from this chat room.');
      io.to(room).emit('banned-user-attempt', {
        username: user,
        deviceId: deviceId,
        time: new Date().toLocaleTimeString()
      });
      return;
    }

    if (role === 'admin') {
      if (passkey !== ADMIN_PASSKEY) {
        socket.emit('auth-error', 'Incorrect Admin passkey.');
        return;
      }
    } else {
      if (passkey !== MEMBER_PASSKEY) {
        socket.emit('auth-error', 'Incorrect Member passkey.');
        return;
      }
    }

    socket.join(room);
    socket.username = user;
    socket.role = role;
    socket.deviceId = deviceId;
    socket.room = room;

    socket.emit('auth-success');
    socket.emit('chat-history', chatHistory);

    const sysMsg = {
      id: 'sys_' + Date.now(),
      type: 'system',
      payload: { text: `${user} joined the chat.` }
    };
    chatHistory.push(sysMsg);
    io.to(room).emit('chat-message', sysMsg);
  });

  socket.on('chat-message', (data) => {
    const { room, type, payload, deviceId } = data;

    if (bannedUsers.has(socket.username) || bannedDevices.has(deviceId)) {
      socket.emit('user-banned', 'You have been banned.');
      return;
    }

    if (socket.role !== 'admin' && type === 'text' && containsBadWords(payload.text)) {
      let warnings = userWarnings.get(socket.username) || 0;
      warnings += 1;
      userWarnings.set(socket.username, warnings);

      if (warnings < 3) {
        socket.emit('warning-msg', `⚠️ Warning (${warnings}/2): Abusive language is not allowed! Reaching 3 warnings will result in an automatic ban.`);
        return;
      } else {
        bannedUsers.add(socket.username);
        if (deviceId) bannedDevices.add(deviceId);
        userWarnings.delete(socket.username);

        socket.emit('user-banned', 'You have been automatically banned after 3 warnings for using abusive language.');
        
        const banNotice = {
          id: 'sys_' + Date.now(),
          type: 'system',
          payload: { text: `🚨 ${socket.username} was automatically banned after 3 abusive language warnings.` }
        };
        chatHistory.push(banNotice);
        io.to(room).emit('chat-message', banNotice);

        socket.disconnect();
        return;
      }
    }

    const msg = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      type: type,
      role: socket.role,
      payload: payload
    };

    chatHistory.push(msg);
    io.to(room).emit('chat-message', msg);
  });

  socket.on('delete-message', ({ room, msgId }) => {
    const index = chatHistory.findIndex(m => m.id === msgId);
    if (index !== -1) {
      chatHistory.splice(index, 1);
      io.to(room).emit('message-deleted', { msgId });
    }
  });

  socket.on('admin-clear-all-messages', ({ room }) => {
    if (socket.role === 'admin') {
      chatHistory.length = 0;
      io.to(room).emit('all-messages-cleared');
    }
  });

  socket.on('admin-ban-user', ({ room, username }) => {
    if (socket.role === 'admin') {
      bannedUsers.add(username);
      const targetSocket = Array.from(io.sockets.sockets.values()).find(s => s.username === username);
      if (targetSocket) {
        if (targetSocket.deviceId) bannedDevices.add(targetSocket.deviceId);
        targetSocket.emit('user-banned', 'You were banned by an admin.');
        targetSocket.disconnect();
      }
      socket.emit('admin-action-success', `User ${username} banned successfully.`);
    }
  });

  socket.on('admin-unban-user', ({ room, username }) => {
    if (socket.role === 'admin') {
      bannedUsers.delete(username);
      userWarnings.delete(username);
      bannedDevices.clear();
      socket.emit('admin-action-success', `User ${username} unbanned successfully.`);
    }
  });

  // --- Voice Call WebRTC Signaling ---
  socket.on('webrtc-offer', (data) => {
    socket.to(data.room).emit('webrtc-offer', { offer: data.offer, from: socket.username });
  });

  socket.on('webrtc-answer', (data) => {
    socket.to(data.room).emit('webrtc-answer', { answer: data.answer, from: socket.username });
  });

  socket.on('webrtc-ice', (data) => {
    socket.to(data.room).emit('webrtc-ice', { candidate: data.candidate, from: socket.username });
  });

  socket.on('end-call', (data) => {
    socket.to(data.room).emit('call-ended', { from: socket.username });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

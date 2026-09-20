const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 });

app.use(express.static('public'));

const PASSKEYS = {
  member: '9460',
  admin: 'M4nil@l019'
};

// English & Hinglish Banned Words List
const BANNED_WORDS = [
  // English
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'pussy', 'scam',
  // Hinglish / Hindi
  'bc', 'mc', 'bhenchod', 'madarchod', 'gaand', 'gand', 'chutiya', 'chutiye', 
  'bsdk', 'bhosdike', 'harami', 'saala', 'sala', 'kamina', 'kamine', 'maderchod',
  'bhen ke lode', 'bhenkelode', 'gandmarike', 'randi', 'lauda', 'loda'
];

const messages = [];
const bannedUsers = new Set();
const bannedDevices = new Set();
const userWarnings = new Map(); // Tracks strike counts per user

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, user, role, passkey, deviceId }) => {
    if (bannedUsers.has(user) || bannedDevices.has(deviceId)) {
      socket.emit('user-banned', 'You or your device is permanently banned from this chat.');
      return;
    }

    if (PASSKEYS[role] !== passkey) {
      socket.emit('auth-error', 'Invalid Passkey!');
      return;
    }

    socket.join(room);
    socket.userData = { user, role, deviceId, room };

    socket.emit('auth-success');
    socket.emit('chat-history', messages);

    const sysMsg = {
      id: 'sys_' + Date.now(),
      type: 'system',
      payload: { text: `👋 ${user} joined the chat.` }
    };
    messages.push(sysMsg);
    io.to(room).emit('chat-message', sysMsg);
  });

  socket.on('chat-message', (data) => {
    const { room, type, payload, deviceId } = data;

    if (bannedUsers.has(payload.user) || bannedDevices.has(deviceId)) {
      socket.emit('user-banned', 'You are banned from participating.');
      return;
    }

    // Auto-Moderation Check for Text Messages (English & Hinglish)
    if (type === 'text' && payload.text) {
      const lowerText = payload.text.toLowerCase();
      
      // Match exact words or substrings for slang filters
      const containsAbusive = BANNED_WORDS.some(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'i');
        return regex.test(lowerText) || lowerText.includes(word);
      });

      if (containsAbusive) {
        const currentStrikes = (userWarnings.get(payload.user) || 0) + 1;
        userWarnings.set(payload.user, currentStrikes);

        if (currentStrikes >= 3) {
          bannedUsers.add(payload.user);
          if (deviceId) bannedDevices.add(deviceId);

          const banMsg = {
            id: 'sys_' + Date.now(),
            type: 'system',
            payload: { text: `🚫 ${payload.user} was automatically banned after receiving 3 warnings for abusive language.` }
          };
          messages.push(banMsg);
          io.to(room).emit('chat-message', banMsg);
          socket.emit('user-banned', 'You have been automatically banned for repeated use of abusive language (3 Strikes).');
          socket.disconnect();
          return;
        } else {
          socket.emit('warning-msg', `⚠️ Warning (${currentStrikes}/3): Abusive language (English/Hinglish) is strictly prohibited! Message deleted. You will be permanently banned after 3 warnings.`);
          return; // Block message from broadcast
        }
      }
    }

    const msgObj = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      type: type,
      role: socket.userData ? socket.userData.role : 'member',
      payload: payload
    };

    messages.push(msgObj);
    io.to(room).emit('chat-message', msgObj);
  });

  socket.on('delete-message', ({ room, msgId }) => {
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx !== -1) {
      messages.splice(idx, 1);
      io.to(room).emit('message-deleted', { msgId });
    }
  });

  socket.on('admin-clear-all-messages', ({ room }) => {
    if (socket.userData && socket.userData.role === 'admin') {
      messages.length = 0;
      io.to(room).emit('all-messages-cleared');
    }
  });

  socket.on('admin-ban-user', ({ room, username }) => {
    if (socket.userData && socket.userData.role === 'admin') {
      bannedUsers.add(username);
      io.to(room).emit('user-banned-notice', { username });
    }
  });

  socket.on('admin-unban-user', ({ room, username }) => {
    if (socket.userData && socket.userData.role === 'admin') {
      bannedUsers.delete(username);
      userWarnings.delete(username);
      socket.emit('admin-action-success', `User ${username} has been unbanned.`);
    }
  });

  // WebRTC Audio Signaling
  socket.on('call-user', (data) => {
    socket.to(data.room).emit('incoming-call', { signal: data.signalData, from: data.from });
  });

  socket.on('accept-call', (data) => {
    socket.to(data.room).emit('call-accepted', data.signal);
  });

  socket.on('end-call', (data) => {
    socket.to(data.room).emit('call-ended');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

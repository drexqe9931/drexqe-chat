const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 1e8 // 100MB for media/files
});

app.use(express.static(path.join(__dirname, 'public')));

// Persistent file storage setup
const DATA_FILE = path.join(__dirname, 'messages.json');
let chatHistory = [];

if (fs.existsSync(DATA_FILE)) {
  try {
    chatHistory = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    chatHistory = [];
  }
}

function saveHistory() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(chatHistory, null, 2));
}

const bannedUsers = new Set();
const bannedDevices = new Set();
const userWarnings = new Map();
const callParticipants = new Map(); // socketId -> { user, room }

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
    saveHistory();
    io.to(room).emit('chat-message', sysMsg);
  });

  socket.on('chat-message', (data) => {
    const { room, type, payload, deviceId } = data;

    if (bannedUsers.has(socket.username) || bannedDevices.has(deviceId)) {
      socket.emit('user-banned', 'You have been banned.');
      return;
    }

    // Abusive language detection & 3-warning system
    if (type === 'text' && containsBadWords(payload.text)) {
      let warnings = userWarnings.get(socket.username) || 0;
      warnings += 1;
      userWarnings.set(socket.username, warnings);

      if (warnings < 3) {
        socket.emit('warning-msg', `⚠️ Warning (${warnings}/2): Abusive language is strictly prohibited!`);
        return;
      } else {
        bannedUsers.add(socket.username);
        if (deviceId) bannedDevices.add(deviceId);
        userWarnings.delete(socket.username);

        socket.emit('user-banned', 'Banned after 3 warnings for abusive language.');

        const banNotice = {
          id: 'sys_' + Date.now(),
          type: 'system',
          payload: { text: `🚨 ${socket.username} was automatically banned after 3 warnings.` }
        };
        chatHistory.push(banNotice);
        saveHistory();
        io.to(room).emit('chat-message', banNotice);

        socket.disconnect();
        return;
      }
    }

    const msg = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      type: type, // text, image, file, voice, call-announcement
      role: socket.role,
      replyTo: data.replyTo || null,
      payload: payload
    };

    chatHistory.push(msg);
    saveHistory();
    io.to(room).emit('chat-message', msg);
  });

  socket.on('delete-message', ({ room, msgId }) => {
    const index = chatHistory.findIndex(m => m.id === msgId);
    if (index !== -1) {
      const msg = chatHistory[index];
      // Only message author or admin can delete
      if (socket.role === 'admin' || msg.payload.user === socket.username) {
        chatHistory.splice(index, 1);
        saveHistory();
        io.to(room).emit('message-deleted', { msgId });
      }
    }
  });

  // Admin Control Panel Events
  socket.on('admin-clear-all-messages', ({ room }) => {
    if (socket.role === 'admin') {
      chatHistory.length = 0;
      saveHistory();
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
      socket.emit('admin-action-success', `User ${username} unbanned successfully.`);
    }
  });

  // Group Call Signaling & Call Start Announcement
  socket.on('start-voice-call-announcement', ({ room }) => {
    const callMsg = {
      id: 'call_ann_' + Date.now(),
      type: 'call-announcement',
      payload: { user: socket.username, text: `📞 ${socket.username} started a group voice call!` }
    };
    chatHistory.push(callMsg);
    saveHistory();
    io.to(room).emit('chat-message', callMsg);
  });

  socket.on('join-voice-call', ({ room }) => {
    const existingCallers = [];
    callParticipants.forEach((val, sid) => {
      if (val.room === room) {
        existingCallers.push({ socketId: sid, username: val.user });
      }
    });

    callParticipants.set(socket.id, { user: socket.username, room });
    socket.emit('existing-callers', existingCallers);
  });

  socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('webrtc-offer', {
      fromSocketId: socket.id,
      fromUsername: socket.username,
      offer
    });
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('webrtc-answer', {
      fromSocketId: socket.id,
      answer
    });
  });

  socket.on('webrtc-ice', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc-ice', {
      fromSocketId: socket.id,
      candidate
    });
  });

  socket.on('leave-voice-call', () => {
    if (callParticipants.has(socket.id)) {
      const info = callParticipants.get(socket.id);
      callParticipants.delete(socket.id);
      socket.to(info.room).emit('caller-left', { socketId: socket.id, username: socket.username });
    }
  });

  socket.on('disconnect', () => {
    if (callParticipants.has(socket.id)) {
      const info = callParticipants.get(socket.id);
      callParticipants.delete(socket.id);
      socket.to(info.room).emit('caller-left', { socketId: socket.id, username: socket.username });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

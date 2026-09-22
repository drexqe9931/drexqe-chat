const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 1e8
});

app.use(express.static(path.join(__dirname, 'public')));

const chatHistory = [];
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
        socket.emit('warning-msg', `⚠️ Warning (${warnings}/2): Abusive language is not allowed!`);
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

  // --- FULL MESH VOICE CALL SIGNALING & ANNOUNCEMENTS ---
  socket.on('join-voice-call', ({ room }) => {
    // Collect active call members in room
    const existingCallers = [];
    callParticipants.forEach((val, sid) => {
      if (val.room === room) {
        existingCallers.push({ socketId: sid, username: val.user });
      }
    });

    callParticipants.set(socket.id, { user: socket.username, room });

    // Inform joining user about current call participants
    socket.emit('existing-callers', existingCallers);

    // Broadcast announcement into main chat
    const callMsg = {
      id: 'sys_call_' + Date.now(),
      type: 'system',
      payload: { text: `📞 ${socket.username} joined the group voice call!` }
    };
    chatHistory.push(callMsg);
    io.to(room).emit('chat-message', callMsg);
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

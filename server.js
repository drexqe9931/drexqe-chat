const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8 // 100 MB max payload for files
});

app.use(express.static(path.join(__dirname, 'public')));

// PASSKEYS SET HERE
const MEMBER_PASSKEY = "9460";
const ADMIN_PASSKEY = "M4nil@l019";

let chatHistory = [];
let bannedDevices = new Set();
let userWarnings = {};
let activeCallUsers = new Set();

const ABUSE_WORDS = ["badword1", "badword2"]; // Add any filtered words here

io.on('connection', (socket) => {
  
  socket.on('join-room', ({ room, user, role, passkey, deviceId }) => {
    if (bannedDevices.has(deviceId)) {
      return socket.emit('user-banned', 'Your device is permanently banned from this chat.');
    }

    // Force string comparison to avoid type mismatches
    const cleanPasskey = String(passkey).trim();
    const isMemberValid = role === 'member' && cleanPasskey === MEMBER_PASSKEY;
    const isAdminValid = role === 'admin' && cleanPasskey === ADMIN_PASSKEY;

    if (!isMemberValid && !isAdminValid) {
      return socket.emit('auth-error', 'Invalid passkey for selected role.');
    }

    socket.join(room);
    socket.data = { user, role, deviceId, room };
    
    socket.emit('auth-success');
    socket.emit('chat-history', chatHistory);

    io.to(room).emit('chat-message', {
      type: 'system',
      payload: { text: `👋 ${user} joined the chat.` }
    });
  });

  socket.on('chat-message', ({ room, id, type, payload, deviceId }) => {
    if (bannedDevices.has(deviceId)) return;

    if (payload.text) {
      const lowerText = payload.text.toLowerCase();
      const detectedWord = ABUSE_WORDS.find(w => lowerText.includes(w));
      if (detectedWord) {
        userWarnings[deviceId] = (userWarnings[deviceId] || 0) + 1;
        if (userWarnings[deviceId] >= 3) {
          bannedDevices.add(deviceId);
          return socket.emit('user-banned', 'You were automatically banned for repeated policy violations.');
        }
        return socket.emit('abuse-warning', { warnings: userWarnings[deviceId], word: detectedWord });
      }
    }

    const msgData = {
      id: id || "msg_" + Date.now(),
      type: type || "text",
      role: socket.data.role || "member",
      payload: payload
    };

    chatHistory.push(msgData);
    if (chatHistory.length > 200) chatHistory.shift();

    io.to(room).emit('chat-message', msgData);
  });

  socket.on('delete-message', ({ room, msgId }) => {
    chatHistory = chatHistory.filter(m => m.id !== msgId);
    io.to(room).emit('message-deleted', { msgId });
  });

  socket.on('admin-clear-all-messages', ({ room }) => {
    if (socket.data.role === 'admin') {
      chatHistory = [];
      io.to(room).emit('all-messages-cleared');
    }
  });

  socket.on('admin-ban-user', ({ room, username }) => {
    if (socket.data.role === 'admin') {
      for (let [id, s] of io.of("/").sockets) {
        if (s.data.user === username) {
          bannedDevices.add(s.data.deviceId);
          s.emit('user-banned', 'You have been banned by an admin.');
          s.disconnect();
        }
      }
      io.to(room).emit('update-banned-list', Array.from(bannedDevices));
    }
  });

  socket.on('admin-unban-user', ({ room, username }) => {
    if (socket.data.role === 'admin') {
      io.to(room).emit('update-banned-list', Array.from(bannedDevices));
    }
  });

  socket.on('get-banned-users', () => {
    socket.emit('update-banned-list', Array.from(bannedDevices));
  });

  // WebRTC Signaling
  socket.on('voice-join', ({ room, user }) => {
    activeCallUsers.add(user);
    socket.to(room).emit('user-joined-call', { socketId: socket.id, user });
    io.to(room).emit('update-call-users', Array.from(activeCallUsers));
  });

  socket.on('voice-signal', ({ target, signal }) => {
    io.to(target).emit('voice-signal', { sender: socket.id, signal });
  });

  socket.on('voice-leave', ({ room }) => {
    if (socket.data && socket.data.user) {
      activeCallUsers.delete(socket.data.user);
      io.to(room).emit('update-call-users', Array.from(activeCallUsers));
    }
    socket.to(room).emit('user-left-call', { socketId: socket.id });
  });

  socket.on('disconnect', () => {
    if (socket.data && socket.data.user) {
      activeCallUsers.delete(socket.data.user);
      if (socket.data.room) {
        io.to(socket.data.room).emit('update-call-users', Array.from(activeCallUsers));
        socket.to(socket.data.room).emit('user-left-call', { socketId: socket.id });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

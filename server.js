const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const PASSKEYS = { member: "110202", admin: "1102" };
const MSG_FILE = path.join(__dirname, 'messages.json');

app.use(express.static('public'));

let chatHistory = [];
if (fs.existsSync(MSG_FILE)) {
  try {
    chatHistory = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8'));
  } catch (err) {
    chatHistory = [];
  }
}

function saveMessages() {
  fs.writeFileSync(MSG_FILE, JSON.stringify(chatHistory, null, 2));
}

let bannedUsers = [];
let bannedDevices = [];
let deviceWarnings = {};
let activeVoiceUsers = {};

const BANNED_WORDS = ["badword1", "badword2", "spam", "abuse", "fuck", "shit", "bitch"];

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, user, role, passkey, deviceId }) => {
    if (bannedUsers.includes(user) || bannedDevices.includes(deviceId)) {
      return socket.emit('auth-error', 'Your username or device is permanently banned from this chat.');
    }

    if (PASSKEYS[role] !== passkey) {
      return socket.emit('auth-error', 'Invalid passkey for selected role.');
    }

    socket.join(room);
    socket.userData = { room, user, role, deviceId };

    socket.emit('auth-success');
    
    socket.emit('chat-history', chatHistory);

    socket.to(room).emit('chat-message', {
      type: 'system',
      payload: { text: `${user} joined as ${role}.` }
    });
  });

  socket.on('chat-message', (data) => {
    const { room, id, type, payload, deviceId } = data;
    if (!socket.userData) return;

    if (bannedUsers.includes(socket.userData.user) || bannedDevices.includes(deviceId)) {
      return socket.emit('user-banned', 'You have been banned.');
    }

    if (payload.text) {
      const lowerText = payload.text.toLowerCase();
      const detectedWord = BANNED_WORDS.find(w => lowerText.includes(w));

      if (detectedWord) {
        deviceWarnings[deviceId] = (deviceWarnings[deviceId] || 0) + 1;
        const currentWarns = deviceWarnings[deviceId];

        if (currentWarns >= 3) {
          if (!bannedDevices.includes(deviceId)) bannedDevices.push(deviceId);
          if (!bannedUsers.includes(socket.userData.user)) bannedUsers.push(socket.userData.user);
          io.to(room).emit('update-banned-list', bannedUsers);
          return socket.emit('user-banned', `Device banned due to repeated policy violations (${detectedWord}).`);
        } else {
          return socket.emit('abuse-warning', { warnings: currentWarns, word: detectedWord });
        }
      }
    }

    const msgObj = {
      id: id || "msg_" + Date.now(),
      type: type || "text",
      payload: payload,
      role: socket.userData.role,
      timestamp: Date.now()
    };

    chatHistory.push(msgObj);
    if (chatHistory.length > 500) chatHistory.shift();
    saveMessages();

    io.to(room).emit('chat-message', msgObj);
  });

  socket.on('delete-message', ({ room, msgId }) => {
    chatHistory = chatHistory.filter(m => m.id !== msgId);
    saveMessages();
    io.to(room).emit('message-deleted', { msgId });
  });

  socket.on('admin-clear-all-messages', ({ room }) => {
    if (socket.userData && socket.userData.role === 'admin') {
      chatHistory = [];
      saveMessages();
      io.to(room).emit('all-messages-cleared');
    }
  });

  socket.on('admin-ban-user', ({ room, username }) => {
    if (socket.userData && socket.userData.role === 'admin') {
      if (!bannedUsers.includes(username)) {
        bannedUsers.push(username);
        io.to(room).emit('update-banned-list', bannedUsers);
      }
    }
  });

  socket.on('admin-unban-user', ({ room, username }) => {
    if (socket.userData && socket.userData.role === 'admin') {
      bannedUsers = bannedUsers.filter(u => u !== username);
      io.to(room).emit('update-banned-list', bannedUsers);
    }
  });

  socket.on('get-banned-users', () => {
    socket.emit('update-banned-list', bannedUsers);
  });

  socket.on('voice-join', ({ room, user }) => {
    if (!activeVoiceUsers[room]) activeVoiceUsers[room] = {};
    
    const peerSockets = Object.keys(activeVoiceUsers[room]);
    socket.emit('call-peers-list', peerSockets);

    activeVoiceUsers[room][socket.id] = user;
    socket.to(room).emit('user-joined-call', { socketId: socket.id, user });
    io.to(room).emit('update-call-users', Object.values(activeVoiceUsers[room]));
  });

  socket.on('voice-signal', ({ target, signal }) => {
    io.to(target).emit('voice-signal', { sender: socket.id, signal });
  });

  socket.on('voice-leave', ({ room }) => {
    if (activeVoiceUsers[room] && activeVoiceUsers[room][socket.id]) {
      delete activeVoiceUsers[room][socket.id];
      socket.to(room).emit('user-left-call', { socketId: socket.id });
      io.to(room).emit('update-call-users', Object.values(activeVoiceUsers[room]));
    }
  });

  socket.on('disconnect', () => {
    if (socket.userData) {
      const { room } = socket.userData;
      if (activeVoiceUsers[room] && activeVoiceUsers[room][socket.id]) {
        delete activeVoiceUsers[room][socket.id];
        socket.to(room).emit('user-left-call', { socketId: socket.id });
        io.to(room).emit('update-call-users', Object.values(activeVoiceUsers[room]));
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

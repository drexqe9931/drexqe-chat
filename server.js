const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50e6 });

app.use(express.static('public'));

// Server-side state tracking
const BANNED_USERS = new Set();
const BANNED_IDENTIFIERS = new Set(); // Stores Device IDs and IPs
const USER_WARNINGS = {}; // username -> warning count
const BANNED_WORDS = ["mc", "bc", "madarchod", "bsdk", "gand", "chutiya"];

function normalizeText(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

io.on('connection', (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

  socket.on('join-room', ({ room, user, role, deviceId }) => {
    socket.username = user;
    socket.userRole = role;
    socket.room = room;
    socket.deviceId = deviceId;
    socket.clientIp = clientIp;

    // Check if banned by username, device ID, or IP
    const isBanned = BANNED_USERS.has(user) || 
                     (deviceId && BANNED_IDENTIFIERS.has(deviceId)) || 
                     BANNED_IDENTIFIERS.has(clientIp);

    if (isBanned && role !== 'admin') {
      socket.emit('banned-notice', '🚫 You are permanently banned from this chat.');
      socket.disconnect(true);
      return;
    }

    socket.join(room);
    updateRoomUsers(room);
  });

  socket.on('chat-message', (data) => {
    const user = socket.username;
    const role = socket.userRole;

    // Admin bypasses word checks
    if (role === 'admin') {
      io.to(data.room).emit('chat-message', data);
      return;
    }

    // Check message content against abusive words
    const rawText = data.payload.text || '';
    const cleanText = normalizeText(rawText);
    
    let isAbusive = false;
    for (const word of BANNED_WORDS) {
      if (cleanText.includes(word)) {
        isAbusive = true;
        break;
      }
    }

    if (isAbusive) {
      USER_WARNINGS[user] = (USER_WARNINGS[user] || 0) + 1;
      const count = USER_WARNINGS[user];

      if (count >= 3) {
        // Auto-ban user on 3rd violation
        BANNED_USERS.add(user);
        if (socket.deviceId) BANNED_IDENTIFIERS.add(socket.deviceId);
        if (socket.clientIp) BANNED_IDENTIFIERS.add(socket.clientIp);

        socket.emit('banned-notice', '🚫 You have been automatically banned for using abusive language 3 times.');
        socket.disconnect(true);
        if (socket.room) updateRoomUsers(socket.room);
      } else {
        // Send warning alert to user (Warning 1 or Warning 2)
        socket.emit('warning-notice', `⚠️ Warning ${count}/3: Please refrain from using abusive language!`);
      }
      return; // Block abusive message from broadcasting
    }

    // Broadcast valid clean message
    io.to(data.room).emit('chat-message', data);
  });

  socket.on('admin-ban-user', ({ username, targetSocketId }) => {
    if (socket.userRole === 'admin') {
      BANNED_USERS.add(username);
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        if (targetSocket.deviceId) BANNED_IDENTIFIERS.add(targetSocket.deviceId);
        if (targetSocket.clientIp) BANNED_IDENTIFIERS.add(targetSocket.clientIp);
        targetSocket.emit('banned-notice', '🚫 You have been permanently banned by an admin.');
        targetSocket.disconnect(true);
      }
      updateRoomUsers(socket.room);
    }
  });

  socket.on('admin-unban-user', ({ username }) => {
    if (socket.userRole === 'admin') {
      BANNED_USERS.delete(username);
      delete USER_WARNINGS[username];
      updateRoomUsers(socket.room);
    }
  });

  socket.on('admin-kick-user', ({ targetSocketId }) => {
    if (socket.userRole === 'admin') {
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.emit('kicked-notice');
        targetSocket.disconnect(true);
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.room) updateRoomUsers(socket.room);
  });

  function updateRoomUsers(room) {
    const clients = io.sockets.adapter.rooms.get(room);
    const userList = [];
    if (clients) {
      for (const id of clients) {
        const clientSocket = io.sockets.sockets.get(id);
        if (clientSocket && clientSocket.username) {
          userList.push({ id, username: clientSocket.username, role: clientSocket.userRole });
        }
      }
    }
    io.to(room).emit('update-user-list', { users: userList, banned: Array.from(BANNED_USERS) });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

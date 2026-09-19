const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50e6 });

app.use(express.static('public'));

const ROOM_PASSKEY = "9460";
const BANNED_USERS = new Set();
const BANNED_IDENTIFIERS = new Set();
const USER_WARNINGS = {};
const BANNED_WORDS = ["mc", "bc", "madarchod", "bsdk", "gand", "chutiya"];
const joinRequests = {};

function normalizeText(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

io.on('connection', (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

  socket.on('join-room', ({ room, user, role, passkey, deviceId, peerId }) => {
    if (passkey !== ROOM_PASSKEY) {
      socket.emit('auth-error', '❌ Incorrect Room Passkey!');
      return;
    }

    socket.username = user;
    socket.userRole = role;
    socket.room = room;
    socket.deviceId = deviceId;
    socket.clientIp = clientIp;
    socket.peerId = peerId;

    const isBanned = BANNED_USERS.has(user) || 
                     (deviceId && BANNED_IDENTIFIERS.has(deviceId)) || 
                     BANNED_IDENTIFIERS.has(clientIp);

    if (isBanned && role !== 'admin') {
      joinRequests[socket.id] = { socketId: socket.id, username: user, role, room, deviceId, clientIp };
      socket.emit('pending-approval-notice', '🔒 You are banned. A join request has been sent to the Admin.');
      io.to(room).emit('admin-join-request', { socketId: socket.id, username: user });
      return;
    }

    socket.join(room);
    socket.emit('auth-success');
    updateRoomUsers(room);
  });

  socket.on('chat-message', (data) => {
    const user = socket.username;
    const role = socket.userRole;

    if (role === 'admin' || data.type === 'voice') {
      io.to(data.room).emit('chat-message', data);
      return;
    }

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
        BANNED_USERS.add(user);
        if (socket.deviceId) BANNED_IDENTIFIERS.add(socket.deviceId);
        if (socket.clientIp) BANNED_IDENTIFIERS.add(socket.clientIp);

        socket.emit('banned-notice', '🚫 You have been automatically banned for using abusive language 3 times.');
        socket.disconnect(true);
        if (socket.room) updateRoomUsers(socket.room);
      } else {
        socket.emit('warning-notice', `⚠️ Warning ${count}/3: Refrain from using abusive language!`);
      }
      return;
    }

    io.to(data.room).emit('chat-message', data);
  });

  socket.on('admin-approve-join', ({ targetSocketId }) => {
    if (socket.userRole !== 'admin') return;

    const req = joinRequests[targetSocketId];
    if (req) {
      BANNED_USERS.delete(req.username);
      if (req.deviceId) BANNED_IDENTIFIERS.delete(req.deviceId);
      if (req.clientIp) BANNED_IDENTIFIERS.delete(req.clientIp);
      delete USER_WARNINGS[req.username];
      delete joinRequests[targetSocketId];

      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.join(req.room);
        targetSocket.emit('approval-granted');
        updateRoomUsers(req.room);
      }
    }
  });

  socket.on('admin-deny-join', ({ targetSocketId }) => {
    if (socket.userRole !== 'admin') return;

    const req = joinRequests[targetSocketId];
    if (req) {
      delete joinRequests[targetSocketId];
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.emit('approval-denied', '🚫 Your request to unban/join was denied by the Admin.');
        targetSocket.disconnect(true);
      }
    }
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
    delete joinRequests[socket.id];
    if (socket.room) updateRoomUsers(socket.room);
  });

  function updateRoomUsers(room) {
    const clients = io.sockets.adapter.rooms.get(room);
    const userList = [];
    if (clients) {
      for (const id of clients) {
        const clientSocket = io.sockets.sockets.get(id);
        if (clientSocket && clientSocket.username) {
          userList.push({ 
            id, 
            username: clientSocket.username, 
            role: clientSocket.userRole,
            peerId: clientSocket.peerId 
          });
        }
      }
    }
    io.to(room).emit('update-user-list', { 
      users: userList, 
      banned: Array.from(BANNED_USERS),
      requests: Object.values(joinRequests)
    });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

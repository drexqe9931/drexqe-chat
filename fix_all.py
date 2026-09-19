import re

# Update server.js with IP + Device ID banning and Unban functionality
server_code = '''const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50e6 });

app.use(express.static('public'));

const BANNED_USERS = new Set();
const BANNED_IDENTIFIERS = new Set(); // Stores IPs and Device IDs
const joinRequests = {}; // socketId -> data
let messageHistory = [];

io.on('connection', (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

  socket.on('join-room', ({ room, user, role, deviceId }) => {
    socket.username = user;
    socket.userRole = role;
    socket.room = room;
    socket.deviceId = deviceId;
    socket.clientIp = clientIp;

    const isBanned = BANNED_USERS.has(user) || 
                     (deviceId && BANNED_IDENTIFIERS.has(deviceId)) || 
                     BANNED_IDENTIFIERS.has(clientIp);

    if (isBanned && role !== 'admin') {
      joinRequests[socket.id] = { socketId: socket.id, username: user, role, room, deviceId, clientIp };
      socket.emit('pending-approval-notice', '🔒 You are banned from this group. A join request has been sent to the Admin.');
      io.to(room).emit('admin-join-request', { socketId: socket.id, username: user, role });
      return;
    }

    socket.join(room);
    socket.emit('load-history', messageHistory);
    updateRoomUsers(room);
  });

  socket.on('chat-message', (data) => {
    messageHistory.push(data.payload);
    if (messageHistory.length > 200) messageHistory.shift();
    io.to(data.room).emit('chat-message', data);
  });

  socket.on('auto-ban-user', ({ username, deviceId }) => {
    BANNED_USERS.add(username);
    if (deviceId) BANNED_IDENTIFIERS.add(deviceId);
    if (socket.clientIp) BANNED_IDENTIFIERS.add(socket.clientIp);

    socket.emit('banned-notice', '🚫 You have been automatically banned for using abusive language 3 times.');
    socket.disconnect(true);
    if (socket.room) updateRoomUsers(socket.room);
  });

  socket.on('admin-clear-history', ({ room }) => {
    if (socket.userRole === 'admin') {
      messageHistory = [];
      io.to(room).emit('history-cleared');
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
    }
  });

  socket.on('admin-unban-user', ({ username }) => {
    if (socket.userRole === 'admin') {
      BANNED_USERS.delete(username);
      io.to(socket.room).emit('system-notice', `User ${username} was unbanned by Admin.`);
    }
  });

  socket.on('admin-approve-join', ({ targetSocketId }) => {
    if (socket.userRole !== 'admin') return;

    const req = joinRequests[targetSocketId];
    if (req) {
      BANNED_USERS.delete(req.username);
      if (req.deviceId) BANNED_IDENTIFIERS.delete(req.deviceId);
      if (req.clientIp) BANNED_IDENTIFIERS.delete(req.clientIp);
      delete joinRequests[targetSocketId];

      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.join(req.room);
        targetSocket.emit('approval-granted');
        targetSocket.emit('load-history', messageHistory);
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
        targetSocket.emit('approval-denied', '🚫 Your join request was denied by the Admin.');
        targetSocket.disconnect(true);
      }
    }
  });

  socket.on('start-call', ({ room, host }) => {
    socket.to(room).emit('call-started', { host });
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
          userList.push({ id, username: clientSocket.username, role: clientSocket.userRole });
        }
      }
    }
    io.to(room).emit('update-user-list', { users: userList, banned: Array.from(BANNED_USERS) });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
'''

with open("server.js", "w") as f:
    f.write(server_code)

print("[✓] server.js patched.")

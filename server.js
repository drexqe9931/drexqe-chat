const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 }); // 100MB limit

app.use(express.static(path.join(__dirname, 'public')));

const roomHistory = {};
const activeUsers = {}; // room -> array of { socketId, username, role }
const bannedUsers = new Set();
let activeCall = null; // Stores current active WebRTC call info

io.on('connection', (socket) => {
  let currentUser = null;
  let currentRoom = null;

  socket.on('join-room', ({ room, user, role }) => {
    if (bannedUsers.has(user.toLowerCase())) {
      socket.emit('banned-notice', 'You are permanently banned from this chat.');
      return;
    }

    currentUser = user;
    currentRoom = room;
    socket.join(room);

    if (!activeUsers[room]) activeUsers[room] = [];
    activeUsers[room] = activeUsers[room].filter(u => u.username !== user);
    activeUsers[room].push({ id: socket.id, username: user, role: role || 'member' });

    if (!roomHistory[room]) roomHistory[room] = [];
    socket.emit('load-history', roomHistory[room]);

    io.to(room).emit('update-user-list', activeUsers[room]);

    if (activeCall && activeCall.room === room) {
      socket.emit('call-started', { host: activeCall.host });
    }
  });

  socket.on('chat-message', (data) => {
    if (bannedUsers.has(currentUser?.toLowerCase())) return;
    if (!roomHistory[data.room]) roomHistory[data.room] = [];
    roomHistory[data.room].push(data.payload);
    if (roomHistory[data.room].length > 100) roomHistory[data.room].shift();
    io.to(data.room).emit('chat-message', data);
  });

  // Admin Controls
  socket.on('admin-clear-history', ({ room }) => {
    roomHistory[room] = [];
    io.to(room).emit('history-cleared');
  });

  socket.on('admin-kick-user', ({ targetSocketId, room }) => {
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('kicked-notice');
      targetSocket.leave(room);
      targetSocket.disconnect(true);
    }
  });

  socket.on('admin-ban-user', ({ username, targetSocketId, room }) => {
    bannedUsers.add(username.toLowerCase());
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('banned-notice', 'You have been permanently banned.');
      targetSocket.leave(room);
      targetSocket.disconnect(true);
    }
  });

  // Video Call Signaling (WebRTC)
  socket.on('start-call', ({ room, host }) => {
    activeCall = { room, host };
    io.to(room).emit('call-started', { host });
  });

  socket.on('end-call', ({ room }) => {
    activeCall = null;
    io.to(room).emit('call-ended');
  });

  socket.on('signal', (data) => {
    io.to(data.to).emit('signal', {
      from: socket.id,
      signal: data.signal,
      senderName: currentUser
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom && activeUsers[currentRoom]) {
      activeUsers[currentRoom] = activeUsers[currentRoom].filter(u => u.id !== socket.id);
      io.to(currentRoom).emit('update-user-list', activeUsers[currentRoom]);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

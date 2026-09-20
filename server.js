const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const callUsers = {};

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, user, role, passkey, deviceId }) => {
    socket.join(room);
    socket.room = room;
    socket.user = user;

    if (!rooms[room]) rooms[room] = { users: {} };
    rooms[room].users[socket.id] = { id: socket.id, username: user, role: role };

    socket.emit('auth-success');
    io.to(room).emit('chat-message', {
      type: 'system',
      payload: { text: `${user} joined the chat.` }
    });
  });

  socket.on('chat-message', (data) => {
    io.to(data.room || socket.room).emit('chat-message', data);
  });

  socket.on('delete-message', ({ room, msgId }) => {
    io.to(room || socket.room).emit('message-deleted', { msgId });
  });

  socket.on('admin-clear-all-messages', ({ room }) => {
    io.to(room || socket.room).emit('all-messages-cleared');
  });

  socket.on('voice-join', (data) => {
    const room = data?.room || socket.room;
    if (!room) return;

    if (!callUsers[room]) callUsers[room] = [];
    if (!callUsers[room].includes(socket.user)) {
      callUsers[room].push(socket.user);
    }

    const roomSockets = Array.from(io.sockets.adapter.rooms.get(room) || []).filter(id => id !== socket.id);
    socket.emit('call-peers-list', roomSockets);
    socket.to(room).emit('user-joined-call', { socketId: socket.id });
    io.to(room).emit('update-call-users', callUsers[room]);
  });

  socket.on('voice-signal', ({ target, signal }) => {
    io.to(target).emit('voice-signal', { sender: socket.id, signal });
  });

  socket.on('voice-leave', (data) => {
    const room = data?.room || socket.room;
    if (!room) return;

    if (callUsers[room]) {
      callUsers[room] = callUsers[room].filter(u => u !== socket.user);
      io.to(room).emit('update-call-users', callUsers[room]);
    }
    socket.to(room).emit('user-left-call', { socketId: socket.id });
  });

  socket.on('disconnect', () => {
    const room = socket.room;
    if (room) {
      if (callUsers[room]) {
        callUsers[room] = callUsers[room].filter(u => u !== socket.user);
        io.to(room).emit('update-call-users', callUsers[room]);
      }
      socket.to(room).emit('user-left-call', { socketId: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

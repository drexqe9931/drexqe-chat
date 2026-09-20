const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// Configure Passkeys
const ADMIN_PASSKEY = "1234";
const MEMBER_PASSKEY = "1234";

const callUsers = {};

io.on('connection', (socket) => {

  socket.on('join-room', ({ room, user, role, passkey }) => {
    // Check passkeys
    if (role === 'admin' && passkey !== ADMIN_PASSKEY) {
      return socket.emit('auth-error', 'Incorrect Admin Passkey!');
    }
    if (role === 'member' && passkey !== MEMBER_PASSKEY) {
      return socket.emit('auth-error', 'Incorrect Member Passkey!');
    }

    socket.join(room);
    socket.room = room;
    socket.user = user;
    socket.role = role;

    socket.emit('auth-success');
    io.to(room).emit('chat-message', {
      type: 'system',
      payload: { text: `${user} joined as ${role}.` }
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
    if (room && callUsers[room]) {
      callUsers[room] = callUsers[room].filter(u => u !== socket.user);
      io.to(room).emit('update-call-users', callUsers[room]);
      socket.to(room).emit('user-left-call', { socketId: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

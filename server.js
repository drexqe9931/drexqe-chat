const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// Passkeys
const ADMIN_PASSKEY = "M4nil@l019";
const MEMBER_PASSKEY = "9460";

// Stores
const bannedUsers = new Set();
const userWarnings = {};
const callUsers = {};

const ABUSIVE_WORDS = ['mc', 'bc', 'madarchod', 'bhenchod', 'gand', 'chutiya', 'bhosdike', 'fuck', 'bitch'];

function containsAbuse(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return ABUSIVE_WORDS.some(word => lower.includes(word));
}

io.on('connection', (socket) => {

  socket.on('join-room', ({ room, user, role, passkey }) => {
    if (bannedUsers.has(user.toLowerCase())) {
      return socket.emit('auth-error', 'You are banned from joining this room.');
    }

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
    const username = socket.user;

    // Abuse check is only active for MEMBERS, admins are exempt
    if (socket.role === 'member' && data.payload && data.payload.text && containsAbuse(data.payload.text)) {
      userWarnings[username] = (userWarnings[username] || 0) + 1;
      const count = userWarnings[username];
      const foundWord = ABUSIVE_WORDS.find(w => data.payload.text.toLowerCase().includes(w));

      if (count >= 3) {
        bannedUsers.add(username.toLowerCase());
        socket.emit('user-banned', 'You have been banned for repeated use of abusive language!');
        socket.leave(socket.room);
        io.to(socket.room).emit('chat-message', {
          type: 'system',
          payload: { text: `🚨 ${username} was automatically banned for abusive language.` }
        });
      } else {
        socket.emit('abuse-warning', { warnings: count, word: foundWord });
      }
      return;
    }

    data.role = socket.role;
    io.to(data.room || socket.room).emit('chat-message', data);
  });

  socket.on('delete-message', ({ room, msgId }) => {
    io.to(room || socket.room).emit('message-deleted', { msgId });
  });

  socket.on('admin-clear-all-messages', ({ room }) => {
    io.to(room || socket.room).emit('all-messages-cleared');
  });

  socket.on('get-banned-users', () => {
    socket.emit('update-banned-list', Array.from(bannedUsers));
  });

  socket.on('admin-ban-user', ({ room, username }) => {
    if (socket.role !== 'admin') return;
    bannedUsers.add(username.toLowerCase());

    const roomSockets = io.sockets.adapter.rooms.get(room || socket.room);
    if (roomSockets) {
      for (const socketId of roomSockets) {
        const s = io.sockets.sockets.get(socketId);
        if (s && s.user && s.user.toLowerCase() === username.toLowerCase()) {
          s.emit('user-banned', 'You have been banned by the Admin.');
          s.leave(room || socket.room);
        }
      }
    }

    io.to(room || socket.room).emit('chat-message', {
      type: 'system',
      payload: { text: `🚨 ${username} was banned by Admin.` }
    });
    io.to(socket.id).emit('update-banned-list', Array.from(bannedUsers));
  });

  socket.on('admin-unban-user', ({ room, username }) => {
    if (socket.role !== 'admin') return;
    bannedUsers.delete(username.toLowerCase());
    if (userWarnings[username]) delete userWarnings[username];

    io.to(room || socket.room).emit('chat-message', {
      type: 'system',
      payload: { text: `✅ ${username} was unbanned by Admin.` }
    });
    io.to(socket.id).emit('update-banned-list', Array.from(bannedUsers));
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

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7 // 10MB payload limit for media
});

app.use(express.static(path.join(__dirname, 'public')));

// Temporary server memory for room message history
const roomHistory = {};

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, user }) => {
    socket.join(room);
    if (!roomHistory[room]) {
      roomHistory[room] = [];
    }
    // Send message history to the newly connected client
    socket.emit('load-history', roomHistory[room]);
  });

  socket.on('chat-message', ({ room, payload }) => {
    if (!roomHistory[room]) {
      roomHistory[room] = [];
    }
    roomHistory[room].push(payload);
    // Keep max 100 recent messages per room
    if (roomHistory[room].length > 100) {
      roomHistory[room].shift();
    }
    io.to(room).emit('chat-message', { payload });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

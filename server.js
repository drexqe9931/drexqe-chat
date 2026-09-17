const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DB_FILE = path.join(__dirname, 'messages.json');
const ADMIN_PASS = "M4nil@l019"; // Admin Key
const MEMBER_PASS = "9460";      // Member Secret Passkey
const HARDCODED_ROOM = "01112011";

function loadMessages() {
  if (!fs.existsSync(DB_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return []; }
}

function saveMessage(msg) {
  const history = loadMessages();
  history.push(msg);
  fs.writeFileSync(DB_FILE, JSON.stringify(history, null, 2));
}

app.use(express.static('public'));

io.on('connection', (socket) => {
  socket.on('join-room', ({ passkey, username, adminPass }) => {
    const isAdmin = (adminPass === ADMIN_PASS);
    
    // Verify passkey for regular members
    if (!isAdmin && passkey !== MEMBER_PASS) {
      return socket.emit('join-error', 'Incorrect Secret Passkey!');
    }

    socket.join(HARDCODED_ROOM);
    socket.isAdmin = isAdmin;
    socket.username = username || (isAdmin ? "Admin" : "Member");

    socket.emit('load-history', {
      history: loadMessages().filter(m => m.roomId === HARDCODED_ROOM),
      isAdmin: socket.isAdmin
    });

    io.to(HARDCODED_ROOM).emit('system-message', `${socket.username} ${isAdmin ? '(Admin)' : ''} joined the group.`);
  });

  socket.on('send-message', (data) => {
    saveMessage(data);
    io.to(HARDCODED_ROOM).emit('receive-message', data);
  });

  socket.on('clear-chat', ({ adminPass }) => {
    if (adminPass === ADMIN_PASS) {
      fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
      io.to(HARDCODED_ROOM).emit('chat-cleared');
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`E2EE Server running on http://localhost:${PORT}`));


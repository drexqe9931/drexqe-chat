const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7 // 10MB limit for media uploads
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory state tracking
const chatHistory = [];
const bannedUsers = new Set();
const bannedDevices = new Set();
const roomPasskeys = { 'main-room': '1234' }; // Default passkey

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, user, role, passkey, deviceId }) => {
    // Check if user or device is banned
    if (bannedUsers.has(user) || bannedDevices.has(deviceId)) {
      socket.emit('auth-error', 'You are banned from this chat room.');
      
      // Notify all admins currently connected that a banned user tried to join
      io.to(room).emit('banned-user-attempt', {
        username: user,
        deviceId: deviceId,
        time: new Date().toLocaleTimeString()
      });
      return;
    }

    // Verify Passkey
    if (passkey !== roomPasskeys[room]) {
      socket.emit('auth-error', 'Incorrect passkey.');
      return;
    }

    socket.join(room);
    socket.username = user;
    socket.role = role;
    socket.deviceId = deviceId;
    socket.room = room;

    socket.emit('auth-success');
    socket.emit('chat-history', chatHistory);

    // Announce user joined
    const sysMsg = {
      id: 'sys_' + Date.now(),
      type: 'system',
      payload: { text: `${user} joined the chat.` }
    };
    chatHistory.push(sysMsg);
    io.to(room).emit('chat-message', sysMsg);
  });

  // Handle incoming chat messages
  socket.on('chat-message', (data) => {
    const { room, type, payload, deviceId } = data;

    if (bannedUsers.has(socket.username) || bannedDevices.has(deviceId)) {
      socket.emit('user-banned', 'You have been banned.');
      return;
    }

    const msg = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      type: type,
      role: socket.role,
      payload: payload
    };

    chatHistory.push(msg);
    io.to(room).emit('chat-message', msg);
  });

  // Handle Message Deletion
  socket.on('delete-message', ({ room, msgId }) => {
    const index = chatHistory.findIndex(m => m.id === msgId);
    if (index !== -1) {
      chatHistory.splice(index, 1);
      io.to(room).emit('message-deleted', { msgId });
    }
  });

  // Admin Actions
  socket.on('admin-clear-all-messages', ({ room }) => {
    if (socket.role === 'admin') {
      chatHistory.length = 0;
      io.to(room).emit('all-messages-cleared');
    }
  });

  socket.on('admin-ban-user', ({ room, username }) => {
    if (socket.role === 'admin') {
      bannedUsers.add(username);
      
      // Find connected socket to get deviceId and disconnect
      const targetSocket = Array.from(io.sockets.sockets.values()).find(s => s.username === username);
      if (targetSocket) {
        if (targetSocket.deviceId) bannedDevices.add(targetSocket.deviceId);
        targetSocket.emit('user-banned', 'You were banned by an admin.');
        targetSocket.disconnect();
      }
      
      socket.emit('admin-action-success', `User ${username} banned successfully.`);
    }
  });

  socket.on('admin-unban-user', ({ room, username }) => {
    if (socket.role === 'admin') {
      // Remove from banned users
      bannedUsers.delete(username);
      
      // Clear associated device IDs from banned list
      bannedDevices.clear(); // Resets device bans so unbanned users can rejoin cleanly
      
      socket.emit('admin-action-success', `User ${username} unbanned successfully.`);
    }
  });

  // Voice Call Signaling
  socket.on('call-user', (data) => {
    socket.to(data.room).emit('incoming-call', data);
  });

  socket.on('end-call', (data) => {
    socket.to(data.room).emit('call-ended');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

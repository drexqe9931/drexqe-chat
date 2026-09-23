const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8 // 100 MB max payload for chunked uploads
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory data stores
const chatHistory = [];
const bannedUsers = new Set();
const activeUploads = {};
const userAbuseCounts = {};

// Hinglish abusive keywords list
const abuseKeywords = ['mc', 'bc', 'chutiya', 'gaand', 'bsdk', 'bhosdike', 'madarchod', 'behenchod', 'harami', 'lauda', 'lodu', 'lode'];

io.on('connection', (socket) => {
  let joinedUser = null;
  let joinedRole = 'member';

  socket.on('join-room', ({ room, user, role, passkey }) => {
    // Passkey verification
    if (role === 'admin' && passkey !== 'M4nil@l019') {
      return socket.emit('auth-error', 'Incorrect Admin Passkey!');
    }
    if (role === 'member' && passkey !== '9460') {
      return socket.emit('auth-error', 'Incorrect Member Passkey!');
    }

    if (bannedUsers.has(user)) {
      return socket.emit('user-banned', '⛔ You are banned from this room.');
    }

    joinedUser = user;
    joinedRole = role;
    socket.username = user;
    socket.role = role;
    socket.join(room);

    socket.emit('auth-success');
    socket.emit('chat-history', chatHistory);

    io.to(room).emit('chat-message', {
      type: 'system',
      payload: { text: `🟢 ${user} (${role}) joined the chat.` }
    });
  });

  socket.on('chat-message', (data) => {
    const username = data.payload.user;
    const text = data.payload.text || '';
    const lowerText = text.toLowerCase();

    // Check for Hinglish abuse words
    const hasAbuse = abuseKeywords.some(word => new RegExp(`\\b${word}\\b`, 'i').test(lowerText));

    if (hasAbuse) {
      userAbuseCounts[username] = (userAbuseCounts[username] || 0) + 1;
      const count = userAbuseCounts[username];

      if (count === 1) {
        socket.emit('warning-msg', '⚠️ WARNING (1/3): Abusive words are strictly prohibited in this group!');
        return;
      } else if (count === 2) {
        socket.emit('warning-msg', '⚠️ FINAL WARNING (2/3): One more abusive message and you will be automatically BANNED!');
        return;
      } else if (count >= 3) {
        bannedUsers.add(username);
        socket.emit('user-banned', '⛔ You have been automatically banned from the group for repeated use of abusive language.');
        socket.disconnect();
        io.to('main-room').emit('chat-message', {
          type: 'system',
          payload: { text: `🚨 ${username} was automatically banned for repeated abuse.` }
        });
        return;
      }
    }

    // Save & broadcast valid message
    const msgData = {
      id: Date.now().toString() + '_' + Math.random().toString(36).substring(2, 7),
      type: data.type || 'text',
      role: socket.role || 'member',
      replyTo: data.replyTo || null,
      payload: data.payload
    };

    chatHistory.push(msgData);
    if (chatHistory.length > 200) chatHistory.shift();

    io.to('main-room').emit('chat-message', msgData);
  });

  // Chunked Media Upload Handlers
  socket.on('upload-start', ({ uploadId, fileName, fileType, fileSize, totalChunks, replyTo }) => {
    activeUploads[uploadId] = {
      fileName,
      fileType,
      fileSize,
      totalChunks,
      replyTo,
      chunks: [],
      user: socket.username
    };
  });

  socket.on('upload-chunk', ({ uploadId, chunkIndex, chunkData }) => {
    const upload = activeUploads[uploadId];
    if (!upload) return;

    upload.chunks[chunkIndex] = Buffer.from(chunkData);

    if (upload.chunks.filter(Boolean).length === upload.totalChunks) {
      const completeBuffer = Buffer.concat(upload.chunks);
      const mimeType = upload.fileType || 'application/octet-stream';
      const base64Data = `data:${mimeType};base64,${completeBuffer.toString('base64')}`;

      const msgType = mimeType.startsWith('image/') ? 'image' : 'file';
      const msgData = {
        id: Date.now().toString() + '_' + Math.random().toString(36).substring(2, 7),
        type: msgType,
        role: socket.role || 'member',
        replyTo: upload.replyTo || null,
        payload: {
          user: upload.user,
          url: base64Data,
          name: upload.fileName,
          size: upload.fileSize
        }
      };

      chatHistory.push(msgData);
      if (chatHistory.length > 200) chatHistory.shift();

      io.to('main-room').emit('chat-message', msgData);
      socket.emit('upload-complete', { uploadId });
      delete activeUploads[uploadId];
    }
  });

  // Message Deletion & Admin Actions
  socket.on('delete-message', ({ room, msgId }) => {
    const idx = chatHistory.findIndex(m => m.id === msgId);
    if (idx !== -1) {
      chatHistory.splice(idx, 1);
      io.to(room).emit('message-deleted', { msgId });
    }
  });

  socket.on('admin-clear-all-messages', ({ room }) => {
    if (socket.role === 'admin') {
      chatHistory.length = 0;
      io.to(room).emit('all-messages-cleared');
    }
  });

  socket.on('admin-ban-user', ({ room, username }) => {
    if (socket.role === 'admin') {
      bannedUsers.add(username);
      io.to(room).emit('chat-message', {
        type: 'system',
        payload: { text: `🚨 ${username} has been banned by Admin.` }
      });
      socket.emit('admin-action-success', `User ${username} has been banned.`);
    }
  });

  socket.on('admin-unban-user', ({ room, username }) => {
    if (socket.role === 'admin') {
      bannedUsers.delete(username);
      delete userAbuseCounts[username];
      socket.emit('admin-action-success', `User ${username} has been unbanned.`);
    }
  });

  // Voice Call Signal Handlers
  socket.on('start-voice-call-announcement', ({ room }) => {
    io.to(room).emit('chat-message', {
      type: 'call-announcement',
      payload: { text: `📞 ${socket.username} started a group audio call.` }
    });
  });

  socket.on('join-voice-call', ({ room }) => {
    socket.join(room + '_voice');
    const clientsInCall = Array.from(io.sockets.adapter.rooms.get(room + '_voice') || [])
      .filter(id => id !== socket.id)
      .map(id => ({ socketId: id, username: io.sockets.sockets.get(id)?.username }));

    socket.emit('existing-callers', clientsInCall);
  });

  socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('webrtc-offer', { fromSocketId: socket.id, fromUsername: socket.username, offer });
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('webrtc-answer', { fromSocketId: socket.id, answer });
  });

  socket.on('webrtc-ice', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc-ice', { fromSocketId: socket.id, candidate });
  });

  socket.on('leave-voice-call', () => {
    socket.rooms.forEach(r => {
      if (r.endsWith('_voice')) {
        socket.leave(r);
        socket.to(r).emit('caller-left', { socketId: socket.id });
      }
    });
  });

  socket.on('disconnect', () => {
    socket.rooms.forEach(r => {
      if (r.endsWith('_voice')) {
        socket.to(r).emit('caller-left', { socketId: socket.id });
      }
    });
    if (joinedUser) {
      io.to('main-room').emit('chat-message', {
        type: 'system',
        payload: { text: `🔴 ${joinedUser} left the chat.` }
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

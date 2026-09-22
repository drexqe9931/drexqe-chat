const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8
});

app.use(express.static(path.join(__dirname, 'public')));

const PASSKEYS = {
  admin: 'M4nil@l019',
  member: '9460'
};

const BAD_WORDS = [
  'badword1', 'badword2', 'fuck', 'shit', 'bitch', 'asshole',
  'bc', 'mc', 'bhenchod', 'madarchod', 'gandu', 'chutiya', 'bhosdike', 'gaand', 'lauta', 'randi', 'harami'
];

const roomData = {
  'main-room': {
    messages: [],
    users: {},
    bannedUsers: new Set(),
    userWarnings: {},
    callers: {}
  }
};

function containsBadWords(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return BAD_WORDS.some(word => lower.includes(word));
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, user, role, passkey }) => {
    const roomState = roomData[room] || roomData['main-room'];

    if (roomState.bannedUsers.has(user)) {
      return socket.emit('user-banned', 'You are banned from this chat.');
    }

    if (PASSKEYS[role] !== passkey) {
      return socket.emit('auth-error', 'Invalid Passkey for selected role.');
    }

    socket.join(room);
    socket.userData = { room, user, role };
    roomState.users[socket.id] = { username: user, role };

    socket.emit('auth-success');
    socket.emit('chat-history', roomState.messages);

    const sysMsg = {
      id: Date.now().toString(),
      type: 'system',
      payload: { text: `${user} joined the chat.` }
    };
    roomState.messages.push(sysMsg);
    io.to(room).emit('chat-message', sysMsg);
  });

  socket.on('chat-message', (data) => {
    const { room, type, payload, replyTo } = data;
    const roomState = roomData[room] || roomData['main-room'];
    const userRole = socket.userData ? socket.userData.role : 'member';

    if (type === 'text' && containsBadWords(payload.text)) {
      if (userRole !== 'admin') {
        const username = socket.userData.user;
        const currentWarns = (roomState.userWarnings[username] || 0) + 1;
        roomState.userWarnings[username] = currentWarns;

        if (currentWarns >= 2) {
          roomState.bannedUsers.add(username);
          socket.emit('user-banned', 'You have been banned for repeated use of prohibited language.');
          socket.disconnect();
          return;
        } else {
          return socket.emit('warning-msg', `⚠️ Warning (${currentWarns}/2): Abusive language is strictly prohibited!`);
        }
      }
    }

    const msgObj = {
      id: Date.now().toString(),
      type,
      replyTo,
      role: userRole,
      payload
    };

    roomState.messages.push(msgObj);
    io.to(room).emit('chat-message', msgObj);
  });

  socket.on('delete-message', ({ room, msgId }) => {
    const roomState = roomData[room] || roomData['main-room'];
    roomState.messages = roomState.messages.filter(m => m.id !== msgId);
    io.to(room).emit('message-deleted', { msgId });
  });

  socket.on('admin-clear-all-messages', ({ room }) => {
    if (socket.userData && socket.userData.role === 'admin') {
      const roomState = roomData[room] || roomData['main-room'];
      roomState.messages = [];
      io.to(room).emit('all-messages-cleared');
    }
  });

  socket.on('admin-ban-user', ({ room, username }) => {
    if (socket.userData && socket.userData.role === 'admin') {
      const roomState = roomData[room] || roomData['main-room'];
      roomState.bannedUsers.add(username);

      for (let [sid, uObj] of Object.entries(roomState.users)) {
        if (uObj.username === username) {
          io.to(sid).emit('user-banned', 'You have been banned by an Admin.');
          io.sockets.sockets.get(sid)?.disconnect();
        }
      }
      socket.emit('admin-action-success', `User ${username} banned.`);
    }
  });

  socket.on('admin-unban-user', ({ room, username }) => {
    if (socket.userData && socket.userData.role === 'admin') {
      const roomState = roomData[room] || roomData['main-room'];
      roomState.bannedUsers.delete(username);
      delete roomState.userWarnings[username];
      socket.emit('admin-action-success', `User ${username} unbanned.`);
    }
  });

  socket.on('start-voice-call-announcement', ({ room }) => {
    const sysMsg = {
      id: Date.now().toString(),
      type: 'call-announcement',
      payload: { text: `${socket.userData.user} started a group voice call!` }
    };
    const roomState = roomData[room] || roomData['main-room'];
    roomState.messages.push(sysMsg);
    io.to(room).emit('chat-message', sysMsg);
  });

  socket.on('join-voice-call', ({ room }) => {
    const roomState = roomData[room] || roomData['main-room'];
    const callersInRoom = Object.values(roomState.callers);

    socket.emit('existing-callers', callersInRoom);

    roomState.callers[socket.id] = {
      socketId: socket.id,
      username: socket.userData.user
    };
  });

  socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('webrtc-offer', {
      fromSocketId: socket.id,
      fromUsername: socket.userData.user,
      offer
    });
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('webrtc-answer', {
      fromSocketId: socket.id,
      answer
    });
  });

  socket.on('webrtc-ice', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc-ice', {
      fromSocketId: socket.id,
      candidate
    });
  });

  socket.on('leave-voice-call', () => {
    handleVoiceLeave(socket);
  });

  socket.on('disconnect', () => {
    handleVoiceLeave(socket);
  });

  function handleVoiceLeave(s) {
    if (s.userData) {
      const roomState = roomData[s.userData.room] || roomData['main-room'];
      if (roomState.callers[s.id]) {
        delete roomState.callers[s.id];
        io.to(s.userData.room).emit('caller-left', { socketId: s.id });
      }
      delete roomState.users[s.id];
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

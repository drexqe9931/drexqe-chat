import re

# --- 1. Patch server.js ---
with open("server.js", "r") as f:
    server_code = f.read()

new_server_code = '''const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50e6 });

app.use(express.static('public'));

const BANNED_WORDS = [
  "bc", "mc", "gand", "gaand", "chutiya", "chutiye", "bhosdike",
  "laude", "lawde", "loda", "lund", "randi", "harami", "kutta", "kamina",
  "saale", "saala", "madarchod", "behenchod", "bhenchod", "gandu", "bsdk", "maderchod"
];

const userStrikes = {};
const bannedUsers = new Set();
const joinRequests = {}; // socketId -> { socketId, username, role, room }
let messageHistory = [];

io.on('connection', (socket) => {

  socket.on('join-room', ({ room, user, role }) => {

    // If user is banned, put them in approval queue instead of letting them join
    if (bannedUsers.has(user)) {
      joinRequests[socket.id] = { socketId: socket.id, username: user, role, room };
      socket.emit('pending-approval-notice', '🔒 Your account is banned. An admin must approve your request to join.');

      // Notify all active admins in the room
      io.to(room).emit('admin-join-request', { socketId: socket.id, username: user, role });
      return;
    }

    socket.join(room);
    socket.username = user;
    socket.userRole = role;
    socket.room = room;

    socket.emit('load-history', messageHistory);
    updateRoomUsers(room);
  });

  socket.on('chat-message', (data) => {
    // ADMIN EXEMPTION: Only inspect text if sender is NOT an admin
    if (socket.userRole !== 'admin' && data.plainText) {
      let text = data.plainText.toLowerCase();
      let hasAbuse = BANNED_WORDS.some(w => text.includes(w));

      if (hasAbuse) {
        userStrikes[socket.id] = (userStrikes[socket.id] || 0) + 1;
        const count = userStrikes[socket.id];

        if (count === 1) {
          socket.emit('warning-notice', '⚠️ Warning 1/3: Abusive language detected! Please keep the chat respectful.');
        } else if (count === 2) {
          socket.emit('warning-notice', '⚠️ Warning 2/3: Final warning! Next violation will get you banned automatically.');
        } else if (count >= 3) {
          bannedUsers.add(socket.username);
          socket.emit('banned-notice', '🚫 You have been automatically banned for repeated violations.');
          socket.disconnect(true);
          updateRoomUsers(data.room);
          return;
        }
      }
    }

    messageHistory.push(data.payload);
    if (messageHistory.length > 200) messageHistory.shift();
    io.to(data.room).emit('chat-message', data);
  });

  socket.on('admin-clear-history', ({ room }) => {
    if (socket.userRole === 'admin') {
      messageHistory = [];
      io.to(room).emit('history-cleared');
    }
  });

  socket.on('admin-kick-user', ({ targetSocketId, room }) => {
    if (socket.userRole === 'admin') {
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.emit('kicked-notice');
        targetSocket.disconnect(true);
      }
    }
  });

  socket.on('admin-ban-user', ({ username, targetSocketId, room }) => {
    if (socket.userRole === 'admin') {
      bannedUsers.add(username);
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.emit('banned-notice', '🚫 You have been banned from this group by an admin.');
        targetSocket.disconnect(true);
      }
    }
  });

  // Admin Approval Decision Handlers
  socket.on('admin-approve-join', ({ targetSocketId }) => {
    if (socket.userRole !== 'admin') return;

    const req = joinRequests[targetSocketId];
    if (req) {
      bannedUsers.delete(req.username); // Unban user
      delete joinRequests[targetSocketId];

      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.join(req.room);
        targetSocket.username = req.username;
        targetSocket.userRole = req.role;
        targetSocket.room = req.room;

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
        targetSocket.emit('approval-denied', '🚫 Your request to join was denied by the admin.');
        targetSocket.disconnect(true);
      }
    }
  });

  socket.on('start-call', ({ room, host }) => {
    socket.to(room).emit('call-started', { host });
  });

  socket.on('disconnect', () => {
    delete userStrikes[socket.id];
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
    io.to(room).emit('update-user-list', userList);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
'''

with open("server.js", "w") as f:
    f.write(new_server_code)
print("[✓] server.js rewritten successfully.")

# --- 2. Patch public/index.html ---
with open("public/index.html", "r") as f:
    html_code = f.read()

# Add Approval Requests UI section into admin modal
modal_insertion = '''      <div id="adminActions" style="display: none; border-bottom: 1px solid #222d34; padding-bottom: 10px;">
        <button class="btn-danger" style="width: 100%; padding: 8px;" onclick="clearAllMessages()">Clear All Group Messages</button>
      </div>
      <div id="joinRequestsSection" style="display: none; border-bottom: 1px solid #222d34; padding-bottom: 10px; margin-top: 10px;">
        <h4 style="color: #e09100; margin-bottom: 6px;">Pending Join Requests</h4>
        <div id="joinRequestsContainer"></div>
      </div>'''

if 'id="joinRequestsSection"' not in html_code:
    html_code = html_code.replace('<div id="adminActions" style="display: none; border-bottom: 1px solid #222d34; padding-bottom: 10px;">\n        <button class="btn-danger" style="width: 100%; padding: 8px;" onclick="clearAllMessages()">Clear All Group Messages</button>\n      </div>', modal_insertion)

# Event Handlers & Admin approval JS additions
js_patch = '''    socket.on("warning-notice", (msg) => { alert(msg); });
    socket.on("banned-notice", (msg) => { alert(msg); localStorage.clear(); location.reload(); });
    
    socket.on("pending-approval-notice", (msg) => {
      alert(msg);
    });

    socket.on("approval-granted", () => {
      alert("✅ Your join request was approved by the admin!");
      document.getElementById("auth-screen").style.display = "none";
      document.getElementById("app-screen").style.display = "flex";
    });

    socket.on("approval-denied", (msg) => {
      alert(msg);
      localStorage.clear();
      location.reload();
    });

    socket.on("admin-join-request", (data) => {
      if (userRole === "admin") {
        document.getElementById("joinRequestsSection").style.display = "block";
        const container = document.getElementById("joinRequestsContainer");
        const row = document.createElement("div");
        row.id = `req-${data.socketId}`;
        row.className = "user-row";
        row.innerHTML = `
          <span><b>${data.username}</b> (${data.role})</span>
          <div class="user-actions">
            <button class="btn-warn" style="background:#00a884; color:#111b21;" onclick="approveJoin('${data.socketId}')">Approve</button>
            <button class="btn-danger" onclick="denyJoin('${data.socketId}')">Deny</button>
          </div>
        `;
        container.appendChild(row);
        openAdminModal();
      }
    });

    function approveJoin(socketId) {
      socket.emit("admin-approve-join", { targetSocketId: socketId });
      const el = document.getElementById(`req-${socketId}`);
      if (el) el.remove();
    }

    function denyJoin(socketId) {
      socket.emit("admin-deny-join", { targetSocketId: socketId });
      const el = document.getElementById(`req-${socketId}`);
      if (el) el.remove();
    }'''

if 'socket.on("admin-join-request"' not in html_code:
    html_code = html_code.replace('socket.on("warning-notice", (msg) => { alert(msg); });\n    socket.on("banned-notice", (msg) => { alert(msg); localStorage.clear(); location.reload(); });', js_patch)

with open("public/index.html", "w") as f:
    f.write(html_code)
print("[✓] public/index.html patched successfully.")


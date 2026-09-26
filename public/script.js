
// --- AUTO-RECONNECT FIX FOR MINIMIZED BROWSER TABS ---
if (typeof socket !== 'undefined') {
  socket.io.opts.reconnection = true;
  socket.io.opts.reconnectionAttempts = Infinity;
  socket.io.opts.reconnectionDelay = 1000;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (!socket.connected) {
        socket.connect();
      }
    }
  });

  socket.on("connect", () => {
    console.log("Reconnected to chat server successfully.");
  });
}

// UDP echo for the relay spike: bun native/echo.ts — anything in on :9797
// goes straight back out to its sender.
const sock = await Bun.udpSocket({
  port: 9797,
  socket: {
    data(socket, buf, port, addr) {
      socket.send(buf, port, addr);
    },
  },
});
console.log("udp echo on :9797");
void sock;

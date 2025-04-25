let currentTurns = {};
// ⚠️ Ta funkcja nie istnieje w Twoim kodzie – wklej ją jako nową
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const cors = require('cors');
app.use(cors({
  origin: "http://127.0.0.1:8080", // Twoje live-server
  credentials: true
}));
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://127.0.0.1:8080",
    methods: ["GET", "POST"]
  }
});
// 🛡️ DANE UŻYTKOWNIKÓW (w pamięci serwera na start)
let users = {}; // { nick: { id, password, xp, level, achievements, ... } }

// Jeśli chcesz, wczytaj dane z pliku JSON przy starcie serwera
 const fs = require('fs');
 if (fs.existsSync('users.json')) {
   users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
 }

app.use(express.json());

// Rejestracja nowego użytkownika
app.post('/api/register', (req, res) => {
  const { nick, password } = req.body;
  if (!nick || !password) return res.status(400).send('Missing nick or password');

  if (users[nick]) {
    return res.status(409).send('User already exists');
  }

  users[nick] = {
    id: "u_" + Math.random().toString(36).substring(2, 10),
    password,
    xp: 0,
    level: 0,
    achievements: {},
    ui: {
      avatar: "avatar1.png",
      background: "bg0.png",
      frame: "default_frame"
    }
  };

  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
  users = JSON.parse(fs.readFileSync('users.json', 'utf8')); // <- to też musi być
  res.sendStatus(200);
});

// Logowanie użytkownika
console.log("Aktualni użytkownicy w pamięci:", users);
app.post('/api/login', (req, res) => {
  const { nick, password } = req.body;
  console.log("Próba logowania:", {nick, password});
console.log("Dane użytkownika na serwerze:", users[nick]);
  if (!nick || !password) return res.status(400).send('Missing nick or password');

  const user = users[nick];
  if (!user || user.password !== password) {
    return res.status(401).send('Invalid credentials');
  }

  res.json({ user });
});

// Pobranie profilu użytkownika
app.get('/api/profile/:nick', (req, res) => {
  const nick = req.params.nick;
  const user = users[nick];
  if (!user) {
    return res.status(404).send('User not found');
  }

  const { password, ...userData } = user; // nie wysyłamy hasła!
  res.json({ user: userData });
});

// Zapisanie profilu użytkownika
app.post('/api/profile/save', (req, res) => {
  const { nick, data } = req.body;
  if (!nick || !data) return res.status(400).send('Missing nick or data');

  if (!users[nick]) {
    return res.status(404).send('User not found');
  }

  // Aktualizujemy dane (poza hasłem)
  users[nick] = {
    ...users[nick],
    ...data,
    password: users[nick].password, // NIE nadpisujemy hasła
  };
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
  users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
  res.sendStatus(200);
});

app.get('/api/users', (req, res) => {
  const safeUsers = {};
  for (const [nick, data] of Object.entries(users)) {
    const { password, ...safeData } = data; // nie wysyłaj hasła
    safeUsers[nick] = safeData;
  }
  res.json({ users: safeUsers });
});

app.post('/api/users/save', (req, res) => {
  const newUsers = req.body.users;
  if (!newUsers) return res.status(400).send('Missing users data');

  for (const [nick, data] of Object.entries(newUsers)) {
    if (users[nick]) {
      users[nick] = { ...users[nick], ...data, password: users[nick].password };
    }
  }
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
  users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
  res.sendStatus(200);
});

const rooms = {}; // roomCode -> [socketId, socketId]

io.on("connection", (socket) => {
  console.log("🔌 Gracz połączony:", socket.id);

  socket.on("createRoom", ({ nickname }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = [socket.id];
    socket.join(roomCode);
    socket.emit("roomCreated", { roomCode });
    console.log(`🆕 Pokój ${roomCode} utworzony przez ${nickname}`);
  });

  socket.on("joinRoom", ({ roomCode, nickname }) => {
    const room = rooms[roomCode];
    if (!room || room.length >= 2) {
      socket.emit("roomError", { message: "Pokój pełny lub nie istnieje" });
      return;
    }
    room.push(socket.id);
    socket.join(roomCode);
    io.to(roomCode).emit("startGame", {
      colorMap: assignColors(room),
    });
    console.log(`✅ Gracz ${nickname} dołączył do pokoju ${roomCode}`);
  });

  socket.on("matchmake", ({ nickname }) => {
    let found = false;
    for (const [code, sockets] of Object.entries(rooms)) {
      if (sockets.length === 1) {
        sockets.push(socket.id);
        socket.join(code);
        io.to(code).emit("startGame", {
          colorMap: assignColors(sockets),
        });
        console.log(`🤝 Automatyczne parowanie: ${sockets[0]} vs ${sockets[1]}`);
        found = true;
        break;
      }
    }
    if (!found) {
      const roomCode = generateRoomCode();
      rooms[roomCode] = [socket.id];
      socket.join(roomCode);
      socket.emit("roomCreated", { roomCode });
    }
  });

  socket.on("move", (data) => {
    console.log("📥 OTRZYMANO move RAW:", JSON.stringify(data, null, 2));
  
    const { roomCode, from, to, promotion, senderId } = data;
  
    if (!roomCode) {
      console.warn("❌ move odebrany bez roomCode – ignoruję");
      return;
    }
  
    // Sprawdzenie i inicjalizacja roomCode
    if (!(roomCode in currentTurns)) {
      console.log(`🔧 Inicjalizuję currentTurns[${roomCode}] = 'w'`);
      currentTurns[roomCode] = 'w';
    }
  
    // Zaktualizowanie tury tylko jeśli ruch zakończony
    const newTurn = currentTurns[roomCode] === 'w' ? 'b' : 'w';
    currentTurns[roomCode] = newTurn;
  
    console.log("🔁 Wysyłam opponentMove z newTurn:", newTurn);
  
    // Przekazujemy ruch z aktualną turą
    io.to(roomCode).emit("opponentMove", {
      from,
      to,
      promotion,
      senderId,
      newTurn
    });
  });     
    

  socket.on("resign", ({ roomCode }) => {
    socket.to(roomCode).emit("gameOver", { reason: "resign" });
  });

  socket.on("timeout", ({ roomCode }) => {
    socket.to(roomCode).emit("gameOver", { reason: "timeout" });
  });

  socket.on("disconnect", () => {
    console.log("❌ Gracz rozłączony:", socket.id);
    for (const [roomCode, sockets] of Object.entries(rooms)) {
      if (sockets.includes(socket.id)) {
        const other = sockets.find((id) => id !== socket.id);
        if (other) io.to(other).emit("opponentLeft");
        delete rooms[roomCode];
        break;
      }
    }
  });
});

function generateRoomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function assignColors(players) {
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  return {
    [shuffled[0]]: "w",
    [shuffled[1]]: "b",
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Serwer działa na http://0.0.0.0:${PORT}`);
});


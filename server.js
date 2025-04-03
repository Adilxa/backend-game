// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

// Инициализируем Express
const app = express();
const server = http.createServer(app);

// Настраиваем Socket.IO с CORS
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Хранилище игровых комнат
const rooms = new Map();

// Игровые константы (соответствуют константам на стороне клиента)
const PLAYER_RADIUS = 35;
const PUCK_RADIUS = 20;
const GOAL_WIDTH = 120;

// Создаем новую игровую комнату
function createRoom(roomId) {
  if (!roomId) {
    roomId = generateRoomId();
  }

  rooms.set(roomId, {
    id: roomId,
    players: [],
    gameState: {
      puckPos: { x: 0, y: 0 },
      puckVelocity: { x: 0, y: 0 },
      player1Pos: { x: 0, y: 0 },
      player2Pos: { x: 0, y: 0 },
      player1Score: 0,
      player2Score: 0,
      canvasSize: { width: 0, height: 0 },
      isPlaying: false,
      lastUpdateTime: Date.now(),
      lastResetTime: Date.now(),
    },
  });

  return roomId;
}

// Генерация ID комнаты
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8);
}

// Сбросить позиции в комнате
function resetPositions(room) {
  const { gameState } = room;
  const { width, height } = gameState.canvasSize;

  // Сбрасываем позицию шайбы в центр
  gameState.puckPos = { x: width / 2, y: height / 2 };
  gameState.puckVelocity = { x: 0, y: 0 };

  // Игрок 1 внизу
  gameState.player1Pos = { x: width / 2, y: height * 0.75 };

  // Игрок 2 вверху
  gameState.player2Pos = { x: width / 2, y: height * 0.25 };

  // Устанавливаем временную метку сброса
  gameState.lastResetTime = Date.now();
}

// Полный сброс игры в комнате
function resetGame(room) {
  resetPositions(room);
  room.gameState.player1Score = 0;
  room.gameState.player2Score = 0;
}

// Функция для правильного ограничения позиции игроков
function enforcePlayerConstraints(room, playerNumber, position) {
  const { canvasSize } = room.gameState;

  // Ограничиваем X-позицию для обоих игроков
  const newX = Math.max(
    PLAYER_RADIUS,
    Math.min(position.x, canvasSize.width - PLAYER_RADIUS)
  );

  let newY;
  if (playerNumber === 1) {
    // Игрок 1 ограничен нижней половиной поля
    newY = Math.max(
      canvasSize.height / 2,
      Math.min(position.y, canvasSize.height - PLAYER_RADIUS)
    );
  } else {
    // Игрок 2 ограничен верхней половиной поля
    newY = Math.min(
      canvasSize.height / 2 - PLAYER_RADIUS,
      Math.max(position.y, PLAYER_RADIUS)
    );
  }

  return { x: newX, y: newY };
}

// Механизм периодической синхронизации состояния игры
function startPeriodicSync() {
  setInterval(() => {
    rooms.forEach((room, roomId) => {
      if (room.gameState.isPlaying && room.players.length === 2) {
        io.to(roomId).emit("syncGameState", room.gameState);
      }
    });
  }, 3000); // Синхронизируем каждые 3 секунды
}

// Обработка WebSocket-соединений
io.on("connection", socket => {
  console.log("Новое подключение:", socket.id);

  // Создание новой игровой комнаты
  socket.on("createRoom", callback => {
    const roomId = createRoom();
    callback({ roomId });
  });

  // Присоединение к существующей комнате
  socket.on("joinRoom", ({ roomId }, callback) => {
    // Проверяем, существует ли комната
    let room = rooms.get(roomId);

    // Если комнаты нет, создаем новую
    if (!room) {
      roomId = createRoom(roomId);
      room = rooms.get(roomId);
    }

    // Проверяем, есть ли место в комнате
    if (room.players.length >= 2) {
      return callback({ success: false, error: "Комната заполнена" });
    }

    // Назначаем номер игрока (1 или 2)
    const playerNumber = room.players.length + 1;
    room.players.push({
      id: socket.id,
      number: playerNumber,
      ready: false,
    });

    // Присоединяемся к комнате socket.io
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerNumber = playerNumber;

    callback({
      success: true,
      playerNumber,
      playersCount: room.players.length,
    });

    // Уведомляем комнату о новом игроке
    io.to(roomId).emit("playerJoined", {
      playerNumber,
      playersCount: room.players.length,
    });

    // Если комната заполнена, отправляем событие готовности
    if (room.players.length === 2) {
      io.to(roomId).emit("roomReady");
    }
  });

  // Игрок готов (canvas инициализирован)
  socket.on("playerReady", ({ canvasSize }) => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.ready = true;

    // Обновляем размер канваса, если это первый готовый игрок
    if (!room.gameState.canvasSize.width) {
      room.gameState.canvasSize = canvasSize;
      resetPositions(room);
    }

    // Проверяем, готовы ли все игроки
    const allReady = room.players.every(p => p.ready);
    if (allReady && room.players.length === 2) {
      room.gameState.isPlaying = true;
      io.to(roomId).emit("gameStart", room.gameState);
    }
  });

  // Движение игрока
  socket.on("playerMove", ({ position }) => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room || !room.gameState.isPlaying) return;

    const playerNumber = socket.playerNumber;

    // Применяем ограничения к позиции игрока
    const constrainedPosition = enforcePlayerConstraints(
      room,
      playerNumber,
      position
    );

    // Обновляем позицию игрока
    if (playerNumber === 1) {
      room.gameState.player1Pos = constrainedPosition;
    } else if (playerNumber === 2) {
      room.gameState.player2Pos = constrainedPosition;
    }

    // Отправляем обновленную позицию другому игроку
    socket.to(roomId).emit("opponentMove", {
      playerNumber,
      position: constrainedPosition,
    });
  });

  // Обновление шайбы
  socket.on("puckUpdate", ({ puckPos, puckVelocity }) => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room || !room.gameState.isPlaying) return;

    room.gameState.puckPos = puckPos;
    room.gameState.puckVelocity = puckVelocity;

    // Отправляем обновление шайбы другому игроку
    socket.to(roomId).emit("puckSync", {
      puckPos,
      puckVelocity,
    });
  });

  // Игрок забил гол
  socket.on("goalScored", ({ scorer }) => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room || !room.gameState.isPlaying) return;

    if (scorer === 1) {
      room.gameState.player1Score++;
    } else if (scorer === 2) {
      room.gameState.player2Score++;
    }

    // Сбрасываем позиции
    resetPositions(room);

    // Добавляем небольшую задержку перед отправкой
    setTimeout(() => {
      io.to(roomId).emit("scoreUpdate", {
        player1Score: room.gameState.player1Score,
        player2Score: room.gameState.player2Score,
        gameState: room.gameState,
      });
    }, 100);
  });

  // Запрос на сброс игры
  socket.on("requestReset", () => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    resetGame(room);

    io.to(roomId).emit("gameReset", room.gameState);
  });

  // Обработка отключения
  socket.on("disconnect", () => {
    console.log("Клиент отключился:", socket.id);

    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    // Удаляем игрока из комнаты
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== -1) {
      room.players.splice(playerIndex, 1);

      // Уведомляем оставшегося игрока
      io.to(roomId).emit("playerLeft", {
        playerNumber: socket.playerNumber,
        playersCount: room.players.length,
      });

      // Если комната пуста, удаляем ее
      if (room.players.length === 0) {
        rooms.delete(roomId);
      } else {
        room.gameState.isPlaying = false;
      }
    }
  });
});

// Базовые маршруты Express
app.get("/rooms", (req, res) => {
  const roomsData = Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    playersCount: room.players.length,
  }));
  res.json(roomsData);
});

// Статические файлы для клиента (если нужно)
app.use(express.static(path.join(__dirname, "public")));

// Запускаем механизм периодической синхронизации
startPeriodicSync();

// Запуск сервера
const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

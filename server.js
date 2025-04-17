// server.js - Серверная часть для Air Hockey
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const cors = require("cors");

// Инициализация Express
const app = express();
const server = http.createServer(app);

// Включение CORS
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Настройка Socket.IO с оптимизированными параметрами
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["*"],
  },
  // Оптимизированные настройки Socket.IO
  pingInterval: 10000, // Проверка соединения каждые 2 секунды
  pingTimeout: 5000, // Считать отключенным после 5 секунд
  transports: ["websocket", "polling"], // Принудительно использовать WebSocket (эффективнее чем polling)
  maxHttpBufferSize: 1e6, // 1 МБ размер буфера (по умолчанию 1 МБ)
  connectionStateRecovery: {
    // Настройки восстановления соединения
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 минуты
    skipMiddlewares: true,
  },
  perMessageDeflate: {
    // Включить сжатие
    threshold: 1024, // Сжимать только данные больше 1 КБ
  },
});

// Хранилище активных матчей с Map для лучшей производительности
const matches = new Map();

// Игровые константы
const PLAYER_RADIUS = 35;
const PUCK_RADIUS = 20;
const GOAL_WIDTH = 120;
const WINNING_SCORE = 10;

// Константы физики
const FRICTION = 0.994; // Трение шайбы - уменьшено для соответствия клиенту
const AIR_RESISTANCE = 0.9995; // Сопротивление воздуха - соответствует клиентской реализации
const BOARD_RESTITUTION = 0.95; // Сохранение энергии при отскоке
const MIN_VELOCITY = 0.3; // Минимальная скорость перед остановкой
const UPDATE_RATE = 1000; // Частота обновления сервера в мс (~60 FPS)

// Получить или создать матч по ID
function getOrCreateMatch(matchId) {
  if (!matches.has(matchId)) {
    console.log(`Создание нового матча: ${matchId}`);
    matches.set(matchId, {
      id: matchId,
      players: [],
      lastGoalTime: 0,
      lastUpdateTime: Date.now(),
      updateInterval: null,
      lastSyncTime: Date.now(),
      collisionHistory: [], // Отслеживание недавних столкновений для избежания дубликатов
      goalCooldown: false, // Предотвращает множественные события гола
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
        gameOver: false,
        winner: 0,
      },
    });
  }

  return matches.get(matchId);
}

// Точный сброс позиций
function resetPositions(match) {
  const { gameState } = match;
  const { width, height } = gameState.canvasSize;

  if (!width || !height) {
    console.log(
      "Предупреждение: размер холста не установлен. Пропуск сброса позиций."
    );
    return false;
  }

  // Сбросить скорость шайбы в ноль ПЕРЕД обновлением позиции для согласованности
  gameState.puckVelocity = { x: 0, y: 0 };

  // Округлить позиции до целых чисел для более согласованной синхронизации
  gameState.puckPos = {
    x: Math.round(width / 2),
    y: Math.round(height / 2),
  };

  // Игрок 1 в нижнем центре
  gameState.player1Pos = {
    x: Math.round(width / 2),
    y: Math.round(height * 0.75),
  };

  // Игрок 2 в верхнем центре
  gameState.player2Pos = {
    x: Math.round(width / 2),
    y: Math.round(height * 0.25),
  };

  // Установить временную метку сброса
  gameState.lastResetTime = Date.now();
  gameState.lastUpdateTime = Date.now();

  // Очистить историю столкновений при сбросе
  match.collisionHistory = [];

  return true;
}

// Полный сброс игры с подтверждением
function resetGame(match) {
  resetPositions(match);
  match.gameState.player1Score = 0;
  match.gameState.player2Score = 0;
  match.gameState.gameOver = false;
  match.gameState.winner = 0;
  match.lastGoalTime = 0;
  match.goalCooldown = false;

  // Вернуть статус успешности
  return true;
}

// Более строгие ограничения позиции игрока
function enforcePlayerConstraints(match, playerNumber, position) {
  const { canvasSize } = match.gameState;

  // Убедиться, что размеры холста действительны
  if (!canvasSize || !canvasSize.width || !canvasSize.height) {
    console.log(
      "Предупреждение: Неверный размер холста для ограничений игрока"
    );
    return position;
  }

  // Округлить координаты для согласованности между клиентом и сервером
  let newX = Math.round(
    Math.max(
      PLAYER_RADIUS,
      Math.min(position.x, canvasSize.width - PLAYER_RADIUS)
    )
  );

  let newY;
  if (playerNumber === 1) {
    // Игрок 1 ограничен нижней половиной (с небольшим буфером)
    newY = Math.round(
      Math.max(
        canvasSize.height / 2 + PLAYER_RADIUS,
        Math.min(position.y, canvasSize.height - PLAYER_RADIUS)
      )
    );
  } else {
    // Игрок 2 ограничен верхней половиной (с небольшим буфером)
    newY = Math.round(
      Math.min(
        canvasSize.height / 2 - PLAYER_RADIUS,
        Math.max(position.y, PLAYER_RADIUS)
      )
    );
  }

  return { x: newX, y: newY };
}

// Улучшенная проверка окончания игры с надежной валидацией
function checkGameOver(match) {
  const { gameState } = match;

  // Проверка безопасности
  if (!gameState) return false;

  // Проверить наличие победного счета
  if (gameState.player1Score >= WINNING_SCORE) {
    gameState.gameOver = true;
    gameState.winner = 1;
    gameState.isPlaying = false;
    return true;
  } else if (gameState.player2Score >= WINNING_SCORE) {
    gameState.gameOver = true;
    gameState.winner = 2;
    gameState.isPlaying = false;
    return true;
  }

  return false;
}

// Улучшенный физический движок с улучшенным обнаружением столкновений
function updatePuckPhysics(match) {
  const { gameState } = match;
  const now = Date.now();
  const deltaTime = Math.min((now - gameState.lastUpdateTime) / 1000, 0.1); // Ограничение до 100мс для предотвращения скачков
  gameState.lastUpdateTime = now;

  // Пропустить физику, если игра не в процессе
  if (!gameState.isPlaying || gameState.gameOver || match.goalCooldown)
    return false;

  // Применить правильные множители трения и сопротивления воздуха
  const frictionFactor = Math.pow(FRICTION, deltaTime);
  const airResistanceFactor = Math.pow(AIR_RESISTANCE, deltaTime);

  // Обновить скорость с трением
  gameState.puckVelocity.x *= frictionFactor * airResistanceFactor;
  gameState.puckVelocity.y *= frictionFactor * airResistanceFactor;

  // Остановить очень медленное движение, чтобы предотвратить бесконечные мелкие движения
  const currentSpeed = Math.sqrt(
    gameState.puckVelocity.x * gameState.puckVelocity.x +
      gameState.puckVelocity.y * gameState.puckVelocity.y
  );
  if (currentSpeed < MIN_VELOCITY) {
    gameState.puckVelocity.x = 0;
    gameState.puckVelocity.y = 0;
    return false; // Нет необходимости продолжать обновление физики
  } else if (currentSpeed < 3) {
    // Применить дополнительное замедление на низких скоростях для более плавной остановки
    const slowdownFactor = 0.98;
    gameState.puckVelocity.x *= slowdownFactor;
    gameState.puckVelocity.y *= slowdownFactor;
  }

  // Вычислить новую позицию, используя текущую скорость
  const newX = gameState.puckPos.x + gameState.puckVelocity.x * deltaTime * 60; // Нормализация для 60 FPS
  const newY = gameState.puckPos.y + gameState.puckVelocity.y * deltaTime * 60;

  // Флаг обнаружения столкновения
  let collisionOccurred = false;

  // Обработать столкновения со стенами
  const { width, height } = gameState.canvasSize;

  // Сначала проверить столкновения с углами для специальной обработки
  const isInCorner = checkCornerCollision(
    newX,
    newY,
    PUCK_RADIUS,
    width,
    height
  );
  if (isInCorner.collision) {
    handleCornerCollision(match, isInCorner.corner);
    collisionOccurred = true;
  } else {
    // Левая стена
    if (newX - PUCK_RADIUS < 0) {
      gameState.puckPos.x = PUCK_RADIUS + 1; // Немного отодвинуть от стены
      gameState.puckVelocity.x = -gameState.puckVelocity.x * BOARD_RESTITUTION;

      // Обеспечить минимальную скорость отскока, чтобы предотвратить прилипание
      if (Math.abs(gameState.puckVelocity.x) < 2) {
        gameState.puckVelocity.x = Math.sign(gameState.puckVelocity.x) * 2;
      }

      collisionOccurred = true;
    }
    // Правая стена
    else if (newX + PUCK_RADIUS > width) {
      gameState.puckPos.x = width - PUCK_RADIUS - 1;
      gameState.puckVelocity.x = -gameState.puckVelocity.x * BOARD_RESTITUTION;

      if (Math.abs(gameState.puckVelocity.x) < 2) {
        gameState.puckVelocity.x = Math.sign(gameState.puckVelocity.x) * 2;
      }

      collisionOccurred = true;
    }
    // Иначе обновить позицию X как обычно
    else {
      gameState.puckPos.x = newX;
    }

    // Верхняя стена/ворота
    if (newY - PUCK_RADIUS < 0) {
      // Проверить, находится ли в зоне ворот
      if (newX > (width - GOAL_WIDTH) / 2 && newX < (width + GOAL_WIDTH) / 2) {
        // Гол забит игроком 1
        if (!match.goalCooldown && gameState.puckVelocity.y < 0) {
          handleGoal(match, 1);
          return true; // Гол забит, не продолжать физику
        } else {
          // Просто отскок, если это не действительный гол
          gameState.puckPos.y = PUCK_RADIUS + 1;
          gameState.puckVelocity.y =
            -gameState.puckVelocity.y * BOARD_RESTITUTION;
          collisionOccurred = true;
        }
      } else {
        // Обычный отскок от стены
        gameState.puckPos.y = PUCK_RADIUS + 1;
        gameState.puckVelocity.y =
          -gameState.puckVelocity.y * BOARD_RESTITUTION;

        if (Math.abs(gameState.puckVelocity.y) < 2) {
          gameState.puckVelocity.y = Math.sign(gameState.puckVelocity.y) * 2;
        }

        collisionOccurred = true;
      }
    }

    // Нижняя стена/ворота
    else if (newY + PUCK_RADIUS > height) {
      // Проверить, находится ли в зоне ворот
      if (newX > (width - GOAL_WIDTH) / 2 && newX < (width + GOAL_WIDTH) / 2) {
        // Гол забит игроком 2
        if (!match.goalCooldown && gameState.puckVelocity.y > 0) {
          handleGoal(match, 2);
          return true; // Гол забит, не продолжать физику
        } else {
          // Просто отскок, если это не действительный гол
          gameState.puckPos.y = height - PUCK_RADIUS - 1;
          gameState.puckVelocity.y =
            -gameState.puckVelocity.y * BOARD_RESTITUTION;
          collisionOccurred = true;
        }
      } else {
        // Обычный отскок от стены
        gameState.puckPos.y = height - PUCK_RADIUS - 1;
        gameState.puckVelocity.y =
          -gameState.puckVelocity.y * BOARD_RESTITUTION;

        if (Math.abs(gameState.puckVelocity.y) < 2) {
          gameState.puckVelocity.y = Math.sign(gameState.puckVelocity.y) * 2;
        }

        collisionOccurred = true;
      }
    }
    // Иначе обновить позицию Y как обычно
    else {
      gameState.puckPos.y = newY;
    }
  }

  // Добавить небольшую случайность к отскокам для большей реалистичности
  if (collisionOccurred) {
    const randomFactor = 1 + (Math.random() * 0.05 - 0.025); // ±2.5% вариация
    gameState.puckVelocity.x *= randomFactor;
    gameState.puckVelocity.y *= randomFactor;

    // Ограничить скорость, чтобы предотвратить экстремальные скорости
    const speed = Math.sqrt(
      gameState.puckVelocity.x * gameState.puckVelocity.x +
        gameState.puckVelocity.y * gameState.puckVelocity.y
    );

    const MAX_SPEED = 35;
    if (speed > MAX_SPEED) {
      const scaleFactor = MAX_SPEED / speed;
      gameState.puckVelocity.x *= scaleFactor;
      gameState.puckVelocity.y *= scaleFactor;
    }
  }

  return collisionOccurred;
}

// Проверка столкновений с углами
function checkCornerCollision(x, y, radius, width, height) {
  const corners = [
    { x: 0, y: 0, name: "topLeft" },
    { x: width, y: 0, name: "topRight" },
    { x: 0, y: height, name: "bottomLeft" },
    { x: width, y: height, name: "bottomRight" },
  ];

  for (const corner of corners) {
    const dx = x - corner.x;
    const dy = y - corner.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < radius) {
      return { collision: true, corner: corner.name };
    }
  }

  return { collision: false };
}

// Обработка столкновений с углами
function handleCornerCollision(match, cornerName) {
  const { gameState } = match;
  const { width, height } = gameState.canvasSize;

  // Определить позицию угла
  let cornerX, cornerY;

  switch (cornerName) {
    case "topLeft":
      cornerX = 0;
      cornerY = 0;
      break;
    case "topRight":
      cornerX = width;
      cornerY = 0;
      break;
    case "bottomLeft":
      cornerX = 0;
      cornerY = height;
      break;
    case "bottomRight":
      cornerX = width;
      cornerY = height;
      break;
    default:
      return; // Неверное имя угла
  }

  // Вектор от угла к шайбе (нормальное направление)
  const dx = gameState.puckPos.x - cornerX;
  const dy = gameState.puckPos.y - cornerY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Нормализованный нормальный вектор
  const nx = dx / distance;
  const ny = dy / distance;

  // Переместить шайбу от угла на радиус + небольшой буфер
  gameState.puckPos.x = cornerX + nx * (PUCK_RADIUS + 1);
  gameState.puckPos.y = cornerY + ny * (PUCK_RADIUS + 1);

  // Вычислить скалярное произведение (проекция скорости на нормаль)
  const dotProduct =
    gameState.puckVelocity.x * nx + gameState.puckVelocity.y * ny;

  // Вычислить компоненты скорости вдоль нормали
  const vnx = dotProduct * nx;
  const vny = dotProduct * ny;

  // Вычислить тангенциальные компоненты (перпендикулярные нормали)
  const vtx = gameState.puckVelocity.x - vnx;
  const vty = gameState.puckVelocity.y - vny;

  // Новая скорость: сохранить тангенциальную компоненту, отразить нормальную компоненту
  const CORNER_ELASTICITY = 0.8; // Немного пониженная эластичность для углов
  gameState.puckVelocity.x = vtx - vnx * CORNER_ELASTICITY;
  gameState.puckVelocity.y = vty - vny * CORNER_ELASTICITY;

  // Добавить небольшой случайный фактор для реалистичности
  const randomFactor = 1 + (Math.random() * 0.1 - 0.05);
  gameState.puckVelocity.x *= randomFactor;
  gameState.puckVelocity.y *= randomFactor;
}

// Обработка забитых голов
function handleGoal(match, scorer) {
  // Предотвратить забивание нескольких голов в быстрой последовательности
  const now = Date.now();
  if (now - match.lastGoalTime < 2000 || match.goalCooldown) {
    return false;
  }

  // Установить время охлаждения и временные метки
  match.lastGoalTime = now;
  match.goalCooldown = true;

  // Временно остановить игру
  match.gameState.isPlaying = false;

  // Обновить счет для забившего игрока
  if (scorer === 1) {
    match.gameState.player1Score++;
  } else if (scorer === 2) {
    match.gameState.player2Score++;
  }

  // Проверить, окончена ли игра
  const isGameOver = checkGameOver(match);

  // Сбросить позиции и остановить шайбу
  resetPositions(match);

  // Отправить обновление счета клиентам
  io.to(match.id).emit("scoreUpdate", {
    player1Score: match.gameState.player1Score,
    player2Score: match.gameState.player2Score,
    gameState: JSON.parse(JSON.stringify(match.gameState)),
    scorer,
  });

  if (isGameOver) {
    // Отправить уведомление об окончании игры
    io.to(match.id).emit("gameOver", {
      winner: match.gameState.winner,
      player1Score: match.gameState.player1Score,
      player2Score: match.gameState.player2Score,
    });
  } else {
    // Возобновить игру после задержки, если игра не окончена
    setTimeout(() => {
      if (match && !match.gameState.gameOver) {
        match.gameState.isPlaying = true;
        match.goalCooldown = false; // Очистить время охлаждения

        // Убедиться, что шайба находится точно в центре с нулевой скоростью
        const { width, height } = match.gameState.canvasSize;
        match.gameState.puckPos = {
          x: Math.round(width / 2),
          y: Math.round(height / 2),
        };
        match.gameState.puckVelocity = { x: 0, y: 0 };

        // Сообщить клиентам о возобновлении игры
        io.to(match.id).emit(
          "resumeGame",
          JSON.parse(JSON.stringify(match.gameState))
        );
      }
    }, 3000);
  }

  return true;
}

// Запустить игровой цикл для конкретного матча
function startGameLoop(matchId) {
  const match = matches.get(matchId);
  if (!match) return;

  // Очистить любой существующий интервал
  if (match.updateInterval) {
    clearInterval(match.updateInterval);
  }

  // Настроить высокочастотный цикл обновления (~60 Гц)
  match.updateInterval = setInterval(() => {
    if (
      match.gameState.isPlaying &&
      match.players.length === 2 &&
      !match.gameState.gameOver
    ) {
      // Обновить физику
      const collisionOccurred = updatePuckPhysics(match);

      // Отправить компактное обновление клиентам
      const updateData = {
        p: {
          x: Math.round(match.gameState.puckPos.x),
          y: Math.round(match.gameState.puckPos.y),
        },
        v: {
          x: Number(match.gameState.puckVelocity.x.toFixed(2)),
          y: Number(match.gameState.puckVelocity.y.toFixed(2)),
        },
        t: Date.now(), // Временная метка для интерполяции клиента
      };

      io.to(matchId).emit("gameUpdate", updateData);

      // Отправить полную синхронизацию периодически или при столкновении
      if (collisionOccurred || Date.now() - match.lastSyncTime > 1000) {
        match.lastSyncTime = Date.now();
        io.to(matchId).emit("puckSync", {
          puckPos: match.gameState.puckPos,
          puckVelocity: match.gameState.puckVelocity,
        });
      }
    }
  }, UPDATE_RATE);
}

// Остановить игровой цикл для матча
function stopGameLoop(matchId) {
  const match = matches.get(matchId);
  if (match && match.updateInterval) {
    clearInterval(match.updateInterval);
    match.updateInterval = null;
  }
}

// Обработчик WebSocket соединений
io.on("connection", socket => {
  console.log("Новое соединение:", socket.id);

  // Присоединиться к существующему матчу
  socket.on("joinMatch", ({ matchId }, callback) => {
    // Получить или создать матч
    let match = getOrCreateMatch(matchId);

    // Проверить, заполнен ли матч
    if (match.players.length >= 2) {
      return callback({ success: false, error: "Матч полон" });
    }

    // Назначить номер игрока (1 или 2)
    const playerNumber = match.players.length + 1;
    match.players.push({
      id: socket.id,
      number: playerNumber,
      ready: false,
    });

    // Присоединиться к комнате Socket.IO
    socket.join(matchId);
    socket.matchId = matchId;
    socket.playerNumber = playerNumber;

    callback({
      success: true,
      playerNumber,
      playersCount: match.players.length,
    });

    // Уведомить матч о новом игроке
    io.to(matchId).emit("playerJoined", {
      playerNumber,
      playersCount: match.players.length,
    });

    // Если матч полон, отправить событие готовности
    if (match.players.length === 2) {
      io.to(matchId).emit("matchReady");
    }
  });

  // Обработчик готовности игрока
  socket.on("playerReady", ({ canvasSize }) => {
    const matchId = socket.matchId;
    if (!matchId) return;

    const match = matches.get(matchId);
    if (!match) return;

    const player = match.players.find(p => p.id === socket.id);
    if (!player) return;

    player.ready = true;

    // Обновить размер холста, если это первый готовый игрок
    if (!match.gameState.canvasSize.width) {
      match.gameState.canvasSize = canvasSize;
      resetPositions(match);
    }

    // Проверить, все ли игроки готовы
    const allReady = match.players.every(p => p.ready);
    if (allReady && match.players.length === 2) {
      match.gameState.isPlaying = true;

      // Запустить игровой цикл
      startGameLoop(matchId);

      // Отправить начальное состояние игры
      io.to(matchId).emit("gameStart", match.gameState);
    }
  });

  // Движение игрока с регулированием
  let lastMoveTime = 0;
  const MOVE_THROTTLE_MS = 16; // ~60fps

  socket.on("playerMove", ({ position, timestamp }) => {
    const now = Date.now();
    // Ограничить обновления для уменьшения сетевого трафика
    if (now - lastMoveTime < MOVE_THROTTLE_MS) return;
    lastMoveTime = now;

    const matchId = socket.matchId;
    if (!matchId) return;

    const match = matches.get(matchId);
    if (!match || !match.gameState.isPlaying || match.gameState.gameOver)
      return;

    const playerNumber = socket.playerNumber;

    // Применить ограничения позиции
    const constrainedPosition = enforcePlayerConstraints(
      match,
      playerNumber,
      position
    );

    // Обновить позицию игрока
    if (playerNumber === 1) {
      match.gameState.player1Pos = constrainedPosition;
    } else if (playerNumber === 2) {
      match.gameState.player2Pos = constrainedPosition;
    }

    // Отправить обновление другому игроку в компактном формате
    socket.to(matchId).emit("opponentMove", {
      playerNumber,
      position: {
        x: Math.round(constrainedPosition.x),
        y: Math.round(constrainedPosition.y),
      },
    });
  });

  // Обновление позиции шайбы с сервера
  socket.on("puckUpdate", ({ puckPos, puckVelocity }) => {
    const matchId = socket.matchId;
    if (!matchId) return;

    const match = matches.get(matchId);
    if (!match || !match.gameState.isPlaying || match.gameState.gameOver)
      return;

    // Обновить позицию и скорость шайбы с некоторыми ограничениями
    match.gameState.puckPos = {
      x: Math.round(puckPos.x),
      y: Math.round(puckPos.y),
    };

    match.gameState.puckVelocity = {
      x: Number(puckVelocity.x.toFixed(2)),
      y: Number(puckVelocity.y.toFixed(2)),
    };

    // Широковещательное обновление для всех игроков в матче, кроме отправителя
    socket.to(matchId).emit("puckSync", { puckPos, puckVelocity });
  });

  // Обработчик для сброса игры
  socket.on("requestReset", () => {
    const matchId = socket.matchId;
    if (!matchId) return;

    const match = matches.get(matchId);
    if (!match) return;

    // Полный сброс игры
    resetGame(match);

    // Уведомить всех игроков о сбросе
    io.to(matchId).emit(
      "gameReset",
      JSON.parse(JSON.stringify(match.gameState))
    );
  });

  // Обработчик разрыва соединения
  socket.on("disconnect", () => {
    const matchId = socket.matchId;
    if (!matchId) return;

    const match = matches.get(matchId);
    if (!match) return;

    // Удалить игрока из матча
    const playerIndex = match.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== -1) {
      const leftPlayerNumber = match.players[playerIndex].number;
      match.players.splice(playerIndex, 1);

      // Остановить игровой цикл
      stopGameLoop(matchId);

      // Уведомить оставшегося игрока
      socket.to(matchId).emit("playerLeft", {
        playerNumber: leftPlayerNumber,
        playersCount: match.players.length,
      });

      // Если матч пуст, удалить его через некоторое время
      if (match.players.length === 0) {
        setTimeout(() => {
          if (
            matches.get(matchId) &&
            matches.get(matchId).players.length === 0
          ) {
            matches.delete(matchId);
            console.log(`Матч ${matchId} удален из-за отсутствия игроков`);
          }
        }, 30000); // 30 секунд ожидания перед удалением
      }
    }
  });

  // Обработчик события забития гола
  socket.on("goalScored", ({ scorer }) => {
    const matchId = socket.matchId;
    if (!matchId) return;

    const match = matches.get(matchId);
    if (!match || match.gameState.gameOver) return;

    // Вызвать обработчик гола
    handleGoal(match, scorer);
  });
});

// Запуск сервера
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

// server.js - Серверная часть для Air Hockey с оптимизацией плавности
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

// Настройка Socket.IO с улучшенными параметрами для уменьшения задержки
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["*"],
  },
  // Оптимизированные настройки для минимизации задержкиxx
  pingInterval: 5000, // Более частая проверка соединения (каждые 5 секунд)
  pingTimeout: 3000, // Более быстрая реакция на отключение
  transports: ["websocket"], // Использовать только WebSocket для минимальной задержки
  maxHttpBufferSize: 1e5, // Уменьшение размера буфера для более быстрой передачи
  perMessageDeflate: {
    threshold: 512, // Сжимать более мелкие сообщения для быстрой передачи
  },
});

// Хранилище активных матчей с Map для лучшей производительности
const matches = new Map();

// Игровые константы
const PLAYER_RADIUS = 35;
const PUCK_RADIUS = 20;
const GOAL_WIDTH = 120;
const WINNING_SCORE = 10;

// Константы физики для более плавного движения
const FRICTION = 0.997; // Слегка уменьшенное трение для более плавного скольжения
const AIR_RESISTANCE = 0.9998; // Уменьшенное сопротивление воздуха
const BOARD_RESTITUTION = 0.97; // Увеличенное сохранение энергии при отскоке
const MIN_VELOCITY = 0.2; // Меньший порог минимальной скорости
const MAX_SPEED = 30; // Максимальная скорость шайбы
const UPDATE_RATE = 16; // ~60 FPS для максимальной плавности (16.67ms)

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
      collisionHistory: [],
      goalCooldown: false,
      // История позиций для интерполяции
      positionHistory: {
        puck: [],
        player1: [],
        player2: [],
      },
      // Сохранение предыдущего состояния для сглаживания
      previousState: null,
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

  // Точные позиции (не округлять для более плавного движения)
  gameState.puckPos = {
    x: width / 2,
    y: height / 2,
  };

  // Игрок 1 в нижнем центре
  gameState.player1Pos = {
    x: width / 2,
    y: height * 0.75,
  };

  // Игрок 2 в верхнем центре
  gameState.player2Pos = {
    x: width / 2,
    y: height * 0.25,
  };

  // Установить временную метку сброса
  gameState.lastResetTime = Date.now();
  gameState.lastUpdateTime = Date.now();

  // Очистить историю столкновений и позиций при сбросе
  match.collisionHistory = [];
  match.positionHistory = {
    puck: [],
    player1: [],
    player2: [],
  };
  match.previousState = null;

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

// Улучшенные ограничения позиции игрока без округления для плавности
function enforcePlayerConstraints(match, playerNumber, position) {
  const { canvasSize } = match.gameState;

  // Убедиться, что размеры холста действительны
  if (!canvasSize || !canvasSize.width || !canvasSize.height) {
    console.log(
      "Предупреждение: Неверный размер холста для ограничений игрока"
    );
    return position;
  }

  // Применить ограничения без округления координат
  let newX = Math.max(
    PLAYER_RADIUS,
    Math.min(position.x, canvasSize.width - PLAYER_RADIUS)
  );

  let newY;
  if (playerNumber === 1) {
    // Игрок 1 ограничен нижней половиной
    newY = Math.max(
      canvasSize.height / 2 + PLAYER_RADIUS,
      Math.min(position.y, canvasSize.height - PLAYER_RADIUS)
    );
  } else {
    // Игрок 2 ограничен верхней половиной
    newY = Math.min(
      canvasSize.height / 2 - PLAYER_RADIUS,
      Math.max(position.y, PLAYER_RADIUS)
    );
  }

  return { x: newX, y: newY };
}

// Проверка окончания игры
function checkGameOver(match) {
  const { gameState } = match;

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

// Вспомогательная функция для проверки столкновения шайбы с игроком
function checkPuckPlayerCollision(puckPos, playerPos) {
  const dx = puckPos.x - playerPos.x;
  const dy = puckPos.y - playerPos.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  return distance < PUCK_RADIUS + PLAYER_RADIUS;
}

// Функция для обработки столкновения шайбы с игроком
function handlePlayerCollision(match, playerNumber) {
  const { gameState } = match;
  const puckPos = gameState.puckPos;
  const playerPos =
    playerNumber === 1 ? gameState.player1Pos : gameState.player2Pos;

  // Создать уникальный ID столкновения
  const collisionId = `${playerNumber}_${Date.now()}`;

  // Проверить, обрабатывали ли мы уже это столкновение
  if (match.collisionHistory.includes(collisionId)) {
    return false;
  }

  // Добавить в историю и ограничить размер истории
  match.collisionHistory.push(collisionId);
  if (match.collisionHistory.length > 10) {
    match.collisionHistory.shift();
  }

  // Вектор от игрока к шайбе
  const dx = puckPos.x - playerPos.x;
  const dy = puckPos.y - playerPos.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Предотвратить деление на ноль
  if (distance === 0) return false;

  // Нормализованный вектор
  const nx = dx / distance;
  const ny = dy / distance;

  // Отодвинуть шайбу от игрока (избежать застревания)
  gameState.puckPos.x = playerPos.x + nx * (PLAYER_RADIUS + PUCK_RADIUS + 1);
  gameState.puckPos.y = playerPos.y + ny * (PLAYER_RADIUS + PUCK_RADIUS + 1);

  // Рассчитать импульс от игрока к шайбе
  // Используем скорость игрока, если она доступна
  let playerSpeed = 0;
  const playerVelocity = { x: 0, y: 0 };

  // Имитация скорости игрока на основе истории позиций
  if (match.positionHistory[`player${playerNumber}`].length >= 2) {
    const history = match.positionHistory[`player${playerNumber}`];
    const current = history[history.length - 1];
    const previous = history[history.length - 2];

    if (current && previous && current.timestamp !== previous.timestamp) {
      const dt = (current.timestamp - previous.timestamp) / 1000;
      if (dt > 0) {
        playerVelocity.x = (current.pos.x - previous.pos.x) / dt;
        playerVelocity.y = (current.pos.y - previous.pos.y) / dt;
        playerSpeed = Math.sqrt(
          playerVelocity.x * playerVelocity.x +
            playerVelocity.y * playerVelocity.y
        );
      }
    }
  }

  // Применить импульс от игрока к шайбе
  const IMPACT_FACTOR = 1.5; // Увеличенный фактор удара для более динамичной игры
  const baseVelocity = 10; // Базовая скорость при ударе

  // Использовать скорость игрока, если она достаточно большая
  if (playerSpeed > 5) {
    gameState.puckVelocity.x = playerVelocity.x * IMPACT_FACTOR;
    gameState.puckVelocity.y = playerVelocity.y * IMPACT_FACTOR;
  } else {
    // Иначе использовать направление от игрока к шайбе
    gameState.puckVelocity.x = nx * baseVelocity;
    gameState.puckVelocity.y = ny * baseVelocity;
  }

  // Добавить небольшую случайность к отскоку для реалистичности
  const randomFactor = 1 + (Math.random() * 0.1 - 0.05); // ±5% вариация
  gameState.puckVelocity.x *= randomFactor;
  gameState.puckVelocity.y *= randomFactor;

  // Ограничить максимальную скорость
  const speed = Math.sqrt(
    gameState.puckVelocity.x * gameState.puckVelocity.x +
      gameState.puckVelocity.y * gameState.puckVelocity.y
  );

  if (speed > MAX_SPEED) {
    const scaleFactor = MAX_SPEED / speed;
    gameState.puckVelocity.x *= scaleFactor;
    gameState.puckVelocity.y *= scaleFactor;
  }

  return true;
}

// Улучшенный физический движок с предсказанием столкновений и сглаживанием
function updatePuckPhysics(match) {
  const { gameState } = match;
  const now = Date.now();

  // Измерение реального времени между кадрами для стабильной физики
  const deltaTime = Math.min((now - gameState.lastUpdateTime) / 1000, 0.05); // Ограничение до 50мс
  gameState.lastUpdateTime = now;

  // Пропустить физику, если игра не в процессе
  if (!gameState.isPlaying || gameState.gameOver || match.goalCooldown)
    return false;

  // Сохранить предыдущее состояние для интерполяции
  if (!match.previousState) {
    match.previousState = {
      puckPos: { ...gameState.puckPos },
      puckVelocity: { ...gameState.puckVelocity },
    };
  } else {
    match.previousState.puckPos = { ...gameState.puckPos };
    match.previousState.puckVelocity = { ...gameState.puckVelocity };
  }

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

    // Добавить в историю позиций для интерполяции
    match.positionHistory.puck.push({
      pos: { ...gameState.puckPos },
      timestamp: now,
    });

    // Ограничить историю
    if (match.positionHistory.puck.length > 10) {
      match.positionHistory.puck.shift();
    }

    return false; // Нет необходимости продолжать обновление физики
  }

  // Вычислить новую позицию, используя текущую скорость
  // Нормализуем для стабильного шага физики независимо от FPS
  const stepFactor = deltaTime * 60; // Нормализация для 60 FPS
  const newX = gameState.puckPos.x + gameState.puckVelocity.x * stepFactor;
  const newY = gameState.puckPos.y + gameState.puckVelocity.y * stepFactor;

  // Флаг обнаружения столкновения
  let collisionOccurred = false;

  // Проверить столкновения с игроками (сначала)
  const player1Collision = checkPuckPlayerCollision(
    { x: newX, y: newY },
    gameState.player1Pos
  );

  const player2Collision = checkPuckPlayerCollision(
    { x: newX, y: newY },
    gameState.player2Pos
  );

  if (player1Collision) {
    handlePlayerCollision(match, 1);
    collisionOccurred = true;
  } else if (player2Collision) {
    handlePlayerCollision(match, 2);
    collisionOccurred = true;
  } else {
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
      // Обработка столкновений с боковыми стенками

      // Левая стена
      if (newX - PUCK_RADIUS < 0) {
        gameState.puckPos.x = PUCK_RADIUS + 0.5; // Небольшой отступ от стены
        gameState.puckVelocity.x =
          -gameState.puckVelocity.x * BOARD_RESTITUTION;

        // Сохранить минимальную скорость отскока
        if (Math.abs(gameState.puckVelocity.x) < 2) {
          gameState.puckVelocity.x = Math.sign(gameState.puckVelocity.x) * 2;
        }

        collisionOccurred = true;
      }
      // Правая стена
      else if (newX + PUCK_RADIUS > width) {
        gameState.puckPos.x = width - PUCK_RADIUS - 0.5;
        gameState.puckVelocity.x =
          -gameState.puckVelocity.x * BOARD_RESTITUTION;

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
        if (
          newX > (width - GOAL_WIDTH) / 2 &&
          newX < (width + GOAL_WIDTH) / 2
        ) {
          // Гол забит игроком 1
          if (!match.goalCooldown && gameState.puckVelocity.y < 0) {
            handleGoal(match, 1);
            return true; // Гол забит, не продолжать физику
          } else {
            // Просто отскок, если это не действительный гол
            gameState.puckPos.y = PUCK_RADIUS + 0.5;
            gameState.puckVelocity.y =
              -gameState.puckVelocity.y * BOARD_RESTITUTION;
            collisionOccurred = true;
          }
        } else {
          // Обычный отскок от стены
          gameState.puckPos.y = PUCK_RADIUS + 0.5;
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
        if (
          newX > (width - GOAL_WIDTH) / 2 &&
          newX < (width + GOAL_WIDTH) / 2
        ) {
          // Гол забит игроком 2
          if (!match.goalCooldown && gameState.puckVelocity.y > 0) {
            handleGoal(match, 2);
            return true; // Гол забит, не продолжать физику
          } else {
            // Просто отскок, если это не действительный гол
            gameState.puckPos.y = height - PUCK_RADIUS - 0.5;
            gameState.puckVelocity.y =
              -gameState.puckVelocity.y * BOARD_RESTITUTION;
            collisionOccurred = true;
          }
        } else {
          // Обычный отскок от стены
          gameState.puckPos.y = height - PUCK_RADIUS - 0.5;
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
  }

  // Ограничить скорость после столкновений
  if (collisionOccurred) {
    const speed = Math.sqrt(
      gameState.puckVelocity.x * gameState.puckVelocity.x +
        gameState.puckVelocity.y * gameState.puckVelocity.y
    );

    if (speed > MAX_SPEED) {
      const scaleFactor = MAX_SPEED / speed;
      gameState.puckVelocity.x *= scaleFactor;
      gameState.puckVelocity.y *= scaleFactor;
    }
  }

  // Добавить в историю позиций для интерполяции
  match.positionHistory.puck.push({
    pos: { ...gameState.puckPos },
    timestamp: now,
  });

  // Ограничить историю
  if (match.positionHistory.puck.length > 10) {
    match.positionHistory.puck.shift();
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

// Улучшенная обработка столкновений с углами
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
  gameState.puckPos.x = cornerX + nx * (PUCK_RADIUS + 0.5);
  gameState.puckPos.y = cornerY + ny * (PUCK_RADIUS + 0.5);

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
  const CORNER_ELASTICITY = 0.85; // Высокая эластичность для более плавных отскоков
  gameState.puckVelocity.x = vtx - vnx * CORNER_ELASTICITY;
  gameState.puckVelocity.y = vty - vny * CORNER_ELASTICITY;

  // Добавить небольшой случайный фактор для реалистичности
  const randomFactor = 1 + (Math.random() * 0.05 - 0.025); // Уменьшенная случайность ±2.5%
  gameState.puckVelocity.x *= randomFactor;
  gameState.puckVelocity.y *= randomFactor;
}

// Улучшенная обработка забитых голов
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

  // Отправить обновление счета клиентам с точными позициями
  io.to(match.id).emit("scoreUpdate", {
    player1Score: match.gameState.player1Score,
    player2Score: match.gameState.player2Score,
    gameState: match.gameState, // Отправляем копию без потери точности
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
          x: width / 2,
          y: height / 2,
        };
        match.gameState.puckVelocity = { x: 0, y: 0 };

        // Очистить историю позиций для чистого старта
        match.positionHistory = {
          puck: [
            {
              pos: { x: width / 2, y: height / 2 },
              timestamp: Date.now(),
            },
          ],
          player1: [],
          player2: [],
        };

        // Сообщить клиентам о возобновлении игры с точными данными
        io.to(match.id).emit("resumeGame", match.gameState);
      }
    }, 3000);
  }

  return true;
}

// Запустить игровой цикл для конкретного матча с высокой частотой обновления
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

      // Использовать интерполяцию для более плавного движения шайбы
      let interpolatedPuckData = { ...match.gameState.puckPos };

      // Применить предсказание движения на основе текущей скорости
      // для компенсации сетевой задержки
      if (
        match.gameState.puckVelocity.x !== 0 ||
        match.gameState.puckVelocity.y !== 0
      ) {
        interpolatedPuckData = {
          x: match.gameState.puckPos.x + match.gameState.puckVelocity.x * 0.05, // Предсказание на 50 мс вперед
          y: match.gameState.puckPos.y + match.gameState.puckVelocity.y * 0.05,
        };
      }

      // Отправить компактное обновление клиентам с высокой точностью данных
      const updateData = {
        p: interpolatedPuckData, // Отправляем плавающие точки без округления
        v: match.gameState.puckVelocity, // Также отправляем точные значения скорости
        t: Date.now(), // Временная метка для интерполяции клиента
        // Добавить флаги для клиентской интерполяции
        interp: true,
        collision: collisionOccurred,
      };

      io.to(matchId).emit("gameUpdate", updateData);

      // Отправить полную синхронизацию при столкновении или периодически
      // с увеличенной частотой для лучшей согласованности
      if (collisionOccurred || Date.now() - match.lastSyncTime > 500) {
        // Каждые 500 мс вместо 1000 мс
        match.lastSyncTime = Date.now();
        io.to(matchId).emit("puckSync", {
          puckPos: match.gameState.puckPos,
          puckVelocity: match.gameState.puckVelocity,
          timestamp: Date.now(),
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

  // Измерение и установка задержки соединения
  let pingStartTime = 0;

  // Отправить пинг для измерения задержки
  function sendPing() {
    pingStartTime = Date.now();
    socket.emit("ping");
  }

  // Настроить регулярное измерение задержки
  const pingInterval = setInterval(sendPing, 5000);

  // Обработчик понга от клиента
  socket.on("pong", () => {
    const latency = Date.now() - pingStartTime;
    socket.latency = latency; // Сохранить задержку для этого клиента
    socket.emit("latencyUpdate", { latency });
  });

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
      latency: 0, // Начальная задержка
    });

    // Присоединиться к комнате Socket.IO
    socket.join(matchId);
    socket.matchId = matchId;
    socket.playerNumber = playerNumber;

    // Отправить информацию о успешном подключении
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

    // Отправить начальный пинг
    sendPing();
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

  // Улучшенный обработчик движения игрока с адаптивным регулированием
  let lastMoveTime = 0;
  let movementBuffer = [];
  const MAX_BUFFER_SIZE = 5;

  socket.on("playerMove", ({ position, timestamp }) => {
    const now = Date.now();
    const matchId = socket.matchId;
    if (!matchId) return;

    const match = matches.get(matchId);
    if (!match || !match.gameState.isPlaying || match.gameState.gameOver)
      return;

    const playerNumber = socket.playerNumber;

    // Добавить в буфер движений
    movementBuffer.push({ position, timestamp: now });
    if (movementBuffer.length > MAX_BUFFER_SIZE) {
      movementBuffer.shift();
    }

    // Адаптивная частота обновлений на основе скорости движения
    const MOVE_THROTTLE_BASE = 16; // ~60fps

    // Рассчитать скорость движения, если есть предыдущие данные
    let movementSpeed = 0;
    if (movementBuffer.length >= 2) {
      const newest = movementBuffer[movementBuffer.length - 1];
      const oldest = movementBuffer[0];
      const dx = newest.position.x - oldest.position.x;
      const dy = newest.position.y - oldest.position.y;
      const dt = newest.timestamp - oldest.timestamp;
      if (dt > 0) {
        movementSpeed = Math.sqrt(dx * dx + dy * dy) / dt;
      }
    }

    // Адаптировать частоту обновлений в зависимости от скорости
    let throttleRate = MOVE_THROTTLE_BASE;
    if (movementSpeed > 1.0) {
      // Уменьшать задержку при быстром движении
      throttleRate = Math.max(8, MOVE_THROTTLE_BASE - movementSpeed * 2);
    } else if (movementSpeed < 0.1) {
      // Увеличивать задержку при медленном движении для экономии ресурсов
      throttleRate = Math.min(33, MOVE_THROTTLE_BASE + 10);
    }

    // Ограничить обновления для уменьшения сетевого трафика
    if (now - lastMoveTime < throttleRate) return;
    lastMoveTime = now;

    // Применить ограничения позиции
    const constrainedPosition = enforcePlayerConstraints(
      match,
      playerNumber,
      position
    );

    // Обновить позицию игрока
    if (playerNumber === 1) {
      match.gameState.player1Pos = constrainedPosition;

      // Добавить в историю позиций
      match.positionHistory.player1.push({
        pos: { ...constrainedPosition },
        timestamp: now,
      });

      // Ограничить размер истории
      if (match.positionHistory.player1.length > 10) {
        match.positionHistory.player1.shift();
      }
    } else if (playerNumber === 2) {
      match.gameState.player2Pos = constrainedPosition;

      // Добавить в историю позиций
      match.positionHistory.player2.push({
        pos: { ...constrainedPosition },
        timestamp: now,
      });

      // Ограничить размер истории
      if (match.positionHistory.player2.length > 10) {
        match.positionHistory.player2.shift();
      }
    }

    // Отправить обновление другому игроку с точными координатами
    socket.to(matchId).emit("opponentMove", {
      playerNumber,
      position: constrainedPosition, // Отправляем оригинальные координаты без округления
      timestamp: now,
      // Добавить информацию о скорости для предсказания на клиенте
      velocity: calculateVelocity(
        playerNumber === 1
          ? match.positionHistory.player1
          : match.positionHistory.player2
      ),
    });

    // Пока соединение активно, проверим столкновение шайбы с игроком
    if (match.gameState.isPlaying) {
      const collision = checkPuckPlayerCollision(
        match.gameState.puckPos,
        constrainedPosition
      );

      if (collision) {
        // Обработать столкновение
        const collisionOccurred = handlePlayerCollision(match, playerNumber);

        if (collisionOccurred) {
          // Немедленно отправить обновление шайбы всем клиентам
          io.to(matchId).emit("puckSync", {
            puckPos: match.gameState.puckPos,
            puckVelocity: match.gameState.puckVelocity,
            timestamp: now,
            collision: true,
          });
        }
      }
    }
  });

  // Вспомогательная функция для расчета скорости на основе истории позиций
  function calculateVelocity(positionHistory) {
    if (positionHistory.length < 2) return { x: 0, y: 0 };

    const newest = positionHistory[positionHistory.length - 1];
    const oldest = positionHistory[positionHistory.length - 2];
    const dt = (newest.timestamp - oldest.timestamp) / 1000;

    if (dt <= 0) return { x: 0, y: 0 };

    return {
      x: (newest.pos.x - oldest.pos.x) / dt,
      y: (newest.pos.y - oldest.pos.y) / dt,
    };
  }

  // Обновление позиции шайбы с клиента (используется для корректировок)
  socket.on("puckUpdate", ({ puckPos, puckVelocity, timestamp }) => {
    const matchId = socket.matchId;
    if (!matchId) return;

    const match = matches.get(matchId);
    if (!match || !match.gameState.isPlaying || match.gameState.gameOver)
      return;

    // Проверка времени задержки обновления
    const now = Date.now();
    const updateAge = now - timestamp;

    // Игнорировать устаревшие обновления (старше 200 мс)
    if (updateAge > 200) return;

    // Для недавних обновлений применить плавное смешивание с серверным состоянием
    const blendFactor = 0.3; // 30% от клиентского обновления, 70% от серверного состояния

    // Обновить позицию и скорость шайбы с применением смешивания
    match.gameState.puckPos = {
      x:
        match.gameState.puckPos.x * (1 - blendFactor) + puckPos.x * blendFactor,
      y:
        match.gameState.puckPos.y * (1 - blendFactor) + puckPos.y * blendFactor,
    };

    match.gameState.puckVelocity = {
      x:
        match.gameState.puckVelocity.x * (1 - blendFactor) +
        puckVelocity.x * blendFactor,
      y:
        match.gameState.puckVelocity.y * (1 - blendFactor) +
        puckVelocity.y * blendFactor,
    };

    // Синхронизация для других клиентов
    socket.to(matchId).emit("puckSync", {
      puckPos: match.gameState.puckPos,
      puckVelocity: match.gameState.puckVelocity,
      timestamp: now,
      clientSync: true, // Флаг, что это синхронизация от клиента
    });
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
    io.to(matchId).emit("gameReset", match.gameState);
  });

  // Обработчик разрыва соединения
  socket.on("disconnect", () => {
    // Очистить интервал пинга
    clearInterval(pingInterval);

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
const PORT = 3001;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

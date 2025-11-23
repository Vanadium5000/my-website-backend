import { Socket, Namespace } from "socket.io";
import { auth } from "../auth";
import { connectToDatabase } from "../db/connect";
import { Collection, ObjectId } from "mongodb";
import {
  QuizspirePlayer,
  QuizspireSettings,
  QuizspireQuestion,
  QuizspireLobby,
  QuizspireGame,
  FlashcardDeck,
  ContentElement,
} from "../db/models";

// Use an async IIFE to handle getting the user collection
let flashcardsCollection: Collection<FlashcardDeck>;
(async () => {
  const connection = await connectToDatabase();
  flashcardsCollection = connection.flashcardsCollection;
})();

const lobbies = new Map<string, QuizspireLobby>(); // code -> lobby
const activeGames = new Map<string, QuizspireGame>(); // code -> game

function generateLobbyCode(): string {
  let code: string;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (lobbies.has(code));
  return code;
}

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Generates a multiple-choice question from a flashcard
 * @param card The flashcard to generate question from
 * @param allDefinitions Array of all definitions in the deck for incorrect options
 * @returns Generated question with shuffled options
 */
function generateQuestion(
  card: any,
  allDefinitions: ContentElement[][]
): QuizspireQuestion {
  const question = card.word;
  const correctDefinition = card.definition;

  // Get 3 random incorrect definitions from other cards
  const otherDefinitions = allDefinitions.filter(
    (def) => def !== correctDefinition
  );
  const incorrectOptions = shuffleArray(otherDefinitions).slice(0, 3);

  // Combine correct and incorrect, shuffle
  const allOptions = shuffleArray([correctDefinition, ...incorrectOptions]);
  const correctIndex = allOptions.indexOf(correctDefinition);

  return {
    question,
    options: allOptions,
    correctIndex,
  };
}

function createPlayer(
  socket: Socket,
  userId: string,
  username: string,
  isHost = false,
  isGuest = false
): QuizspirePlayer {
  return {
    socket,
    userId,
    username,
    score: 0,
    correctAnswers: 0,
    isHost,
    isGuest,
  };
}

function createGuestPlayer(socket: Socket, username: string): QuizspirePlayer {
  const userId = `guest_${socket.id}`;
  return createPlayer(socket, userId, username, false, true);
}

/**
 * Broadcasts lobby update to all players in the lobby
 * @param lobby The lobby to broadcast updates for
 */
function broadcastLobbyUpdate(lobby: QuizspireLobby) {
  const playerData = lobby.players.map((p) => ({
    userId: p.userId,
    username: p.username,
    isHost: p.isHost,
    isGuest: p.isGuest,
  }));

  lobby.players.forEach((player) => {
    player.socket.emit("lobby_update", {
      code: lobby.code,
      players: playerData,
      status: lobby.status,
      deckId: lobby.deckId,
      settings: lobby.settings,
    });
  });
}

/**
 * Starts the next question in the game
 * @param game The active game instance
 */
function startQuestion(game: QuizspireGame) {
  const question = game.questions[game.currentQuestionIndex];
  game.questionStartTime = Date.now();
  game.answersSubmitted.clear();

  console.log(game.lobby.settings);

  // Send question to all players
  game.lobby.players.forEach((player) => {
    player.socket.emit("question", {
      questionIndex: game.currentQuestionIndex,
      question: question.question,
      options: question.options,
      timeLimit: game.lobby.settings.questionTimeLimit,
    });
  });

  // Set timer for question timeout
  game.timer = setTimeout(() => {
    handleQuestionTimeout(game);
  }, game.lobby.settings.questionTimeLimit * 1000);
}

function handleQuestionTimeout(game: QuizspireGame) {
  if (game.timer) {
    clearTimeout(game.timer);
    game.timer = undefined;
  }

  // Auto-submit unanswered as incorrect
  game.lobby.players.forEach((player) => {
    if (!game.answersSubmitted.has(player.userId)) {
      game.answersSubmitted.set(player.userId, -1); // -1 indicates timeout/no answer
    }
  });

  showQuestionResults(game);
}

function showQuestionResults(game: QuizspireGame) {
  const question = game.questions[game.currentQuestionIndex];
  const results = game.lobby.players.map((player) => {
    const selectedIndex = game.answersSubmitted.get(player.userId) ?? -1;
    const isCorrect = selectedIndex === question.correctIndex;
    const timeTaken =
      selectedIndex !== -1 ? Date.now() - game.questionStartTime : null;

    return {
      userId: player.userId,
      username: player.username,
      selectedIndex,
      isCorrect,
      timeTaken,
      score: player.score,
      isGuest: player.isGuest,
    };
  });

  // Broadcast results
  game.lobby.players.forEach((player) => {
    player.socket.emit("question_results", {
      questionIndex: game.currentQuestionIndex,
      correctIndex: question.correctIndex,
      results,
    });
  });

  // Send leaderboard update
  const leaderboard = game.lobby.players
    .map((player) => ({
      userId: player.userId,
      username: player.username,
      score: player.score,
      correctAnswers: player.correctAnswers,
      isGuest: player.isGuest,
    }))
    .sort((a, b) => b.score - a.score);

  game.lobby.players.forEach((player) => {
    player.socket.emit("leaderboard_update", {
      leaderboard,
      winCondition: game.lobby.settings.winCondition,
      threshold:
        game.lobby.settings.winCondition === "score"
          ? game.lobby.settings.scoreThreshold
          : game.lobby.settings.winCondition === "correct_answers"
          ? game.lobby.settings.correctAnswersThreshold
          : game.lobby.settings.timeLimit,
    });
  });

  // Move to next question after delay
  setTimeout(() => {
    nextQuestion(game);
  }, 3000); // 3 second delay
}

function nextQuestion(game: QuizspireGame) {
  game.currentQuestionIndex++;

  if (game.currentQuestionIndex >= game.questions.length) {
    endGame(game, "all_questions_completed");
    return;
  }

  // Check win conditions
  const settings = game.lobby.settings;
  if (settings.winCondition === "correct_answers") {
    const maxCorrect = Math.max(
      ...game.lobby.players.map((p) => p.correctAnswers)
    );
    if (maxCorrect >= settings.correctAnswersThreshold!) {
      endGame(game, "correct_answers_threshold_reached");
      return;
    }
  } else if (settings.winCondition === "score") {
    const maxScore = Math.max(...game.lobby.players.map((p) => p.score));
    if (maxScore >= settings.scoreThreshold!) {
      endGame(game, "score_threshold_reached");
      return;
    }
  }

  startQuestion(game);
}

function endGame(game: QuizspireGame, reason: string) {
  if (game.timer) {
    clearTimeout(game.timer);
    game.timer = undefined;
  }

  game.lobby.status = "ended";

  // Sort players based on win condition
  let sortedPlayers;
  const settings = game.lobby.settings;
  if (settings.winCondition === "correct_answers") {
    sortedPlayers = game.lobby.players
      .map((player) => ({
        userId: player.userId,
        username: player.username,
        score: player.score,
        correctAnswers: player.correctAnswers,
        isGuest: player.isGuest,
      }))
      .sort((a, b) => b.correctAnswers - a.correctAnswers);
  } else {
    // Default to score-based sorting for 'score' and 'time' conditions
    sortedPlayers = game.lobby.players
      .map((player) => ({
        userId: player.userId,
        username: player.username,
        score: player.score,
        correctAnswers: player.correctAnswers,
        isGuest: player.isGuest,
      }))
      .sort((a, b) => b.score - a.score);
  }

  game.lobby.players.forEach((player) => {
    player.socket.emit("game_ended", {
      reason,
      finalScores: sortedPlayers,
      winner: sortedPlayers[0],
    });
  });

  // Keep lobby active for potential restart - don't delete it
  activeGames.delete(game.lobby.code);
}

export function setupQuizspire(nsp: Namespace) {
  nsp.on("connection", async (socket: Socket) => {
    console.log(`User connected to Quizspire: ${socket.id}`);

    let userId: string = `guest_${socket.id}`;
    let username: string = "Guest";
    let isAuthenticated = false;

    const cookie = socket.handshake.headers.cookie;
    if (cookie) {
      try {
        const headers = new Headers(socket.handshake.headers as any);
        const sessionResponse = await auth.api.getSession({ headers });
        if (sessionResponse?.user) {
          const user = sessionResponse.user;
          userId = user.id;
          username = user.name || user.email?.split("@")[0] || "Anonymous";
          isAuthenticated = true;
          console.log(`Authenticated user: ${username} (ID: ${userId})`);
        }
      } catch (error: any) {
        console.error(`Authentication error: ${error.message}`);
        // Continue as guest if auth fails
      }
    }

    // If not authenticated, use default guest credentials
    if (!isAuthenticated) {
      console.log(`Guest user connected: ${username} (ID: ${userId})`);
    }

    socket.data = { userId, username, isAuthenticated };

    // Create lobby
    socket.on(
      "create_lobby",
      async (data: { deckId: string; settings: QuizspireSettings }) => {
        try {
          // Only authenticated users can create lobbies
          if (!isAuthenticated) {
            socket.emit("error", {
              message: "Authentication required to create lobbies",
            });
            return;
          }

          // Validate deck ownership
          const deck = await flashcardsCollection.findOne({
            _id: new ObjectId(data.deckId),
            userId,
          });
          if (!deck) {
            socket.emit("error", {
              message: "Deck not found or access denied",
            });
            return;
          }

          const code = generateLobbyCode();
          const host = createPlayer(socket, userId, username, true);
          const lobby: QuizspireLobby = {
            code,
            host,
            players: data.settings.hostParticipates ? [host] : [],
            deckId: data.deckId,
            settings: data.settings,
            status: "waiting",
          };

          lobbies.set(code, lobby);
          socket.data.lobbyCode = code;

          socket.emit("lobby_created", { code });
          broadcastLobbyUpdate(lobby);
          console.log(`Lobby ${code} created by ${userId}`);
        } catch (error: any) {
          socket.emit("error", { message: error.message });
        }
      }
    );

    // Join lobby
    socket.on("join_lobby", (data: { code: string; username?: string }) => {
      const lobby = lobbies.get(data.code);
      if (!lobby) {
        socket.emit("error", { message: "Lobby not found" });
        return;
      }

      // Allow late joins if setting permits and game is in progress
      const canJoinLate =
        lobby.settings.allowLateJoin && lobby.status === "playing";
      if (lobby.status !== "waiting" && !canJoinLate) {
        socket.emit("error", { message: "Lobby is not accepting new players" });
        return;
      }

      if (lobby.players.length >= 50) {
        // Reasonable limit
        socket.emit("error", { message: "Lobby is full" });
        return;
      }

      // Check if player already in lobby
      if (lobby.players.some((p) => p.userId === userId)) {
        socket.emit("error", { message: "Already in this lobby" });
        return;
      }

      // Use provided username for guests, or authenticated username
      const playerUsername = data.username || username;
      const player = isAuthenticated
        ? createPlayer(socket, userId, playerUsername, false)
        : createGuestPlayer(socket, playerUsername);

      lobby.players.push(player);
      socket.data.lobbyCode = data.code;

      socket.emit("lobby_joined", { code: data.code });
      broadcastLobbyUpdate(lobby);

      // If joining mid-game, send current question
      if (lobby.status === "playing") {
        const game = activeGames.get(data.code);
        if (game) {
          const currentQuestion = game.questions[game.currentQuestionIndex];
          player.socket.emit("question", {
            questionIndex: game.currentQuestionIndex,
            question: currentQuestion.question,
            options: currentQuestion.options,
            timeLimit: lobby.settings.questionTimeLimit,
          });
        }
      }

      console.log(`${userId} joined lobby ${data.code}`);
    });

    // Start game
    socket.on("start_game", async (data?: { settings?: QuizspireSettings }) => {
      const lobbyCode = socket.data.lobbyCode;
      if (!lobbyCode || !lobbies.has(lobbyCode)) {
        socket.emit("error", { message: "Not in a lobby" });
        return;
      }

      const lobby = lobbies.get(lobbyCode)!;
      if (lobby.host.userId !== userId) {
        socket.emit("error", { message: "Only host can start the game" });
        return;
      }

      if (lobby.players.length < 1) {
        socket.emit("error", { message: "Need at least 1 player to start" });
        return;
      }

      // Update settings if provided
      if (data?.settings) {
        lobby.settings = data.settings;
      }

      try {
        // Load deck
        const deck = (await flashcardsCollection.findOne({
          _id: new ObjectId(lobby.deckId),
          userId: lobby.host.userId,
        })) as FlashcardDeck;

        if (!deck || deck.cards.length < 1) {
          socket.emit("error", { message: "Invalid deck" });
          return;
        }

        // Generate questions
        const allDefinitions = deck.cards.map((card) => card.definition);
        const questions = shuffleArray(deck.cards).map((card) =>
          generateQuestion(card, allDefinitions)
        );

        const game: QuizspireGame = {
          lobby,
          currentQuestionIndex: 0,
          questions,
          questionStartTime: 0,
          answersSubmitted: new Map(),
        };

        activeGames.set(lobbyCode, game);
        lobby.status = "playing";

        broadcastLobbyUpdate(lobby);
        startQuestion(game);
        console.log(`Game started in lobby ${lobbyCode}`);
      } catch (error: any) {
        socket.emit("error", { message: error.message });
      }
    });

    // Submit answer
    socket.on("submit_answer", (data: { selectedIndex: number }) => {
      const lobbyCode = socket.data.lobbyCode;
      if (!lobbyCode || !activeGames.has(lobbyCode)) {
        socket.emit("error", { message: "Not in an active game" });
        return;
      }

      const game = activeGames.get(lobbyCode)!;
      if (game.answersSubmitted.has(userId)) {
        socket.emit("error", {
          message: "Already submitted answer for this question",
        });
        return;
      }

      if (data.selectedIndex < 0 || data.selectedIndex > 3) {
        socket.emit("error", { message: "Invalid answer index" });
        return;
      }

      const question = game.questions[game.currentQuestionIndex];
      const isCorrect = data.selectedIndex === question.correctIndex;
      const timeTaken = Date.now() - game.questionStartTime;

      game.answersSubmitted.set(userId, data.selectedIndex);

      // Update player stats
      const player = game.lobby.players.find((p) => p.userId === userId)!;
      let pointsGained = 0;
      if (isCorrect) {
        player.correctAnswers++;
        // Score based on speed (faster = higher score)
        const timeBonus = Math.max(
          0,
          game.lobby.settings.questionTimeLimit - timeTaken / 1000
        );
        pointsGained = 100 + Math.floor(timeBonus * 10);
        player.score += pointsGained;
      } else if (game.lobby.settings.resetOnIncorrect) {
        // Reset progress - set correct answers to 0
        player.correctAnswers = 0;
      }

      // Send immediate feedback to the player
      socket.emit("answer_feedback", {
        isCorrect,
        pointsGained,
        correctIndex: question.correctIndex,
        selectedIndex: data.selectedIndex,
      });

      // Check if all players have answered
      // If hostParticipates is false, exclude the host from the calculation
      if (
        Array.from(game.answersSubmitted.keys()).filter(([key]) =>
          !game.lobby.settings.hostParticipates
            ? key != game.lobby.host.userId
            : true
        ).length ===
        game.lobby.players.length -
          (!game.lobby.settings.hostParticipates ? 1 : 0)
      ) {
        if (game.timer) {
          clearTimeout(game.timer);
          game.timer = undefined;
        }
        showQuestionResults(game);
      }
    });

    // Leave lobby
    socket.on("leave_lobby", () => {
      const lobbyCode = socket.data.lobbyCode;
      if (!lobbyCode) return;

      const lobby = lobbies.get(lobbyCode);
      if (lobby) {
        lobby.players = lobby.players.filter((p) => p.socket.id !== socket.id);

        if (lobby.players.length === 0) {
          // Delete empty lobby
          lobbies.delete(lobbyCode);
          activeGames.delete(lobbyCode);
        } else {
          // If host left, assign new host
          if (lobby.host.socket.id === socket.id) {
            lobby.host = lobby.players[0];
            lobby.host.isHost = true;
          }
          broadcastLobbyUpdate(lobby);
        }
      }

      socket.data.lobbyCode = null;
    });

    // Restart game
    socket.on("restart_game", async () => {
      const lobbyCode = socket.data.lobbyCode;
      if (!lobbyCode || !lobbies.has(lobbyCode)) {
        socket.emit("error", { message: "Not in a lobby" });
        return;
      }

      const lobby = lobbies.get(lobbyCode)!;
      if (lobby.host.userId !== userId) {
        socket.emit("error", { message: "Only host can restart the game" });
        return;
      }

      if (lobby.status !== "ended") {
        socket.emit("error", { message: "Game is not ended yet" });
        return;
      }

      try {
        // Reset player stats
        lobby.players.forEach((player) => {
          player.score = 0;
          player.correctAnswers = 0;
        });

        // Load deck
        const deck = (await flashcardsCollection.findOne({
          _id: new ObjectId(lobby.deckId),
          userId: lobby.host.userId,
        })) as FlashcardDeck;

        if (!deck || deck.cards.length < 1) {
          socket.emit("error", { message: "Invalid deck" });
          return;
        }

        // Generate questions
        const allDefinitions = deck.cards.map((card) => card.definition);
        const questions = shuffleArray(deck.cards).map((card) =>
          generateQuestion(card, allDefinitions)
        );

        const game: QuizspireGame = {
          lobby,
          currentQuestionIndex: 0,
          questions,
          questionStartTime: 0,
          answersSubmitted: new Map(),
        };

        activeGames.set(lobbyCode, game);
        lobby.status = "playing";

        broadcastLobbyUpdate(lobby);
        startQuestion(game);
        console.log(`Game restarted in lobby ${lobbyCode}`);
      } catch (error: any) {
        socket.emit("error", { message: error.message });
      }
    });

    // Kick player
    socket.on("kick_player", (data: { userId: string }) => {
      const lobbyCode = socket.data.lobbyCode;
      if (!lobbyCode || !lobbies.has(lobbyCode)) {
        socket.emit("error", { message: "Not in a lobby" });
        return;
      }

      const lobby = lobbies.get(lobbyCode)!;
      if (lobby.host.userId !== userId) {
        socket.emit("error", { message: "Only host can kick players" });
        return;
      }

      const playerToKick = lobby.players.find((p) => p.userId === data.userId);
      if (!playerToKick) {
        socket.emit("error", { message: "Player not found in lobby" });
        return;
      }

      if (playerToKick.isHost) {
        socket.emit("error", { message: "Cannot kick the host" });
        return;
      }

      // Remove player from lobby
      lobby.players = lobby.players.filter((p) => p.userId !== data.userId);
      playerToKick.socket.emit("kicked", { reason: "Kicked by host" });
      playerToKick.socket.data.lobbyCode = null;

      // If game is active, remove from game as well
      const game = activeGames.get(lobbyCode);
      if (game) {
        game.answersSubmitted.delete(data.userId);
        // If all remaining players have answered, show results
        if (game.answersSubmitted.size === lobby.players.length) {
          if (game.timer) {
            clearTimeout(game.timer);
            game.timer = undefined;
          }
          showQuestionResults(game);
        }
      }

      broadcastLobbyUpdate(lobby);
      console.log(`Player ${data.userId} kicked from lobby ${lobbyCode}`);
    });

    socket.on("disconnect", () => {
      console.log(`User disconnected from Quizspire: ${socket.id}`);
      // Handle same as leave_lobby
      const lobbyCode = socket.data.lobbyCode;
      if (lobbyCode) {
        const lobby = lobbies.get(lobbyCode);
        if (lobby) {
          lobby.players = lobby.players.filter(
            (p) => p.socket.id !== socket.id
          );

          if (lobby.players.length === 0) {
            lobbies.delete(lobbyCode);
            activeGames.delete(lobbyCode);
          } else {
            if (lobby.host.socket.id === socket.id) {
              lobby.host = lobby.players[0];
              lobby.host.isHost = true;
            }
            broadcastLobbyUpdate(lobby);
          }
        }
      }
    });
  });
}

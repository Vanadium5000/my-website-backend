import { Socket, Namespace } from "socket.io";
import { Chess } from "chess.js";
import { auth } from "../auth"; // Better-auth instance
import { updateUserStats } from "../utils/profile";
import { sendNotification } from "../utils/notifications";

interface Player {
  socket: Socket;
  username: string;
  userId: string; // Better-auth user ID
  bid?: number; // Time bid in seconds
}

interface Game {
  id: string;
  white: Player;
  black: Player;
  chess: Chess;
  phase: "bidding" | "playing" | "ended";
  whiteTime: number; // Remaining time in seconds
  blackTime: number; // Remaining time in seconds
  timerInterval?: NodeJS.Timeout; // Active timer interval
  biddingTimerInterval?: NodeJS.Timeout; // Bidding timer interval
  biddingTimeLeft: number; // Remaining bidding time in seconds
  drawOfferFrom?: "white" | "black" | null; // Track pending draw offer
}

const MIN_BID = 60; // Minimum time in seconds

const waitingQueue: Player[] = [];
const activeGames: Map<string, Game> = new Map(); // Key: gameId

function generateGameId(): string {
  return Math.random().toString(36).substring(2, 15);
}

function startTimer(game: Game) {
  if (game.timerInterval) {
    clearInterval(game.timerInterval);
  }

  const currentPlayerTime =
    game.chess.turn() === "w" ? "whiteTime" : "blackTime";

  game.timerInterval = setInterval(() => {
    game[currentPlayerTime] -= 1;
    broadcastTime(game);

    if (game[currentPlayerTime] <= 0) {
      clearInterval(game.timerInterval);
      game.timerInterval = undefined;
      endGame(game, game.chess.turn() === "w" ? "black" : "white", "time");
    }
  }, 1000);
}

function stopTimer(game: Game) {
  if (game.timerInterval) {
    clearInterval(game.timerInterval);
    game.timerInterval = undefined;
  }
}

function stopBiddingTimer(game: Game) {
  if (game.biddingTimerInterval) {
    clearInterval(game.biddingTimerInterval);
    game.biddingTimerInterval = undefined;
  }
}

function startBiddingTimer(game: Game) {
  stopBiddingTimer(game); // Clear any existing timer

  game.biddingTimerInterval = setInterval(() => {
    game.biddingTimeLeft -= 1;
    broadcastBiddingTime(game);

    if (game.biddingTimeLeft <= 0) {
      stopBiddingTimer(game);
      // Set default bids to 120 seconds for players who haven't bid
      if (!game.white.bid) {
        game.white.bid = 120;
      }
      if (!game.black.bid) {
        game.black.bid = 120;
      }
      // Proceed to start the game as if both have bid
      const selectedTime = Math.max(
        MIN_BID,
        Math.min(game.white.bid, game.black.bid)
      );
      game.whiteTime = selectedTime;
      game.blackTime = selectedTime;
      game.phase = "playing";

      const fen = game.chess.fen();
      const startDataWhite = {
        fen,
        your_color: "white",
        opponent: game.black.userId,
        time: selectedTime,
        whiteTime: game.whiteTime,
        blackTime: game.blackTime,
      };
      game.white.socket.emit("start", startDataWhite);

      const startDataBlack = {
        fen,
        your_color: "black",
        opponent: game.white.userId,
        time: selectedTime,
        whiteTime: game.whiteTime,
        blackTime: game.blackTime,
      };
      game.black.socket.emit("start", startDataBlack);

      console.log(
        `Game ${game.id} started with default time ${selectedTime} seconds per player due to bidding timeout`
      );

      // Start white's timer
      startTimer(game);
    }
  }, 1000);
}

function broadcastBiddingTime(game: Game) {
  const biddingData = { timeLeft: game.biddingTimeLeft };
  game.white.socket.emit("bidding_time_update", biddingData);
  game.black.socket.emit("bidding_time_update", biddingData);
}

function broadcastTime(game: Game) {
  const timeData = { whiteTime: game.whiteTime, blackTime: game.blackTime };
  game.white.socket.emit("time_update", timeData);
  game.black.socket.emit("time_update", timeData);
}

async function endGame(
  game: Game,
  winnerColor: "white" | "black" | null,
  reason: string
) {
  stopTimer(game);
  game.phase = "ended";

  const winner = winnerColor
    ? winnerColor === "white"
      ? game.white.userId
      : game.black.userId
    : null;

  const endData = { winner, reason };

  if (game.white.socket.connected) {
    if (winner) {
      game.white.socket.emit("win", endData);
    } else {
      game.white.socket.emit("draw", { reason });
    }
  }
  if (game.black.socket.connected) {
    if (winner) {
      game.black.socket.emit("win", endData);
    } else {
      game.black.socket.emit("draw", { reason });
    }
  }

  // Update user stats in database
  try {
    if (winnerColor) {
      // Winner gets a win
      const winnerPlayer = winnerColor === "white" ? game.white : game.black;
      await updateUserStats(winnerPlayer.userId, "chess", "win");

      // Loser gets a loss
      const loserPlayer = winnerColor === "white" ? game.black : game.white;
      await updateUserStats(loserPlayer.userId, "chess", "loss");

      console.log(
        `Stats updated: ${winnerPlayer.userId} wins, ${loserPlayer.userId} loses`
      );
    } else {
      // Draw: no wins or losses
      console.log("Game ended in draw, no stats updated");
    }
  } catch (error) {
    console.error("Error updating user stats:", error);
  }

  // Clear gameId for both players
  game.white.socket.data.gameId = null;
  game.black.socket.data.gameId = null;
  activeGames.delete(game.id);
  console.log(`Game ${game.id} ended: ${reason}`);
}

export function setupChess(nsp: Namespace) {
  nsp.on("connection", async (socket: Socket) => {
    console.log(`User connected: ${socket.id}`);

    const cookie = socket.handshake.headers.cookie;
    if (!cookie) {
      console.log("No cookie, disconnecting");
      socket.emit("error", { message: "No session cookie provided" });
      return socket.disconnect();
    }

    let sessionResponse;
    try {
      const headers = new Headers(socket.handshake.headers as any);
      sessionResponse = await auth.api.getSession({ headers });
      if (!sessionResponse?.user) {
        throw new Error("No valid session data found");
      }
    } catch (error: any) {
      console.error(`Authentication error: ${error.message}`);
      socket.emit("error", {
        message: `Authentication failed: ${error.message}`,
      });
      return socket.disconnect();
    }

    const user = sessionResponse.user;
    const username = user.name || user.email?.split("@")[0] || "Anonymous";
    const userId = user.id; // Better-auth user ID
    console.log(`Authenticated user: ${username} (ID: ${userId})`);

    socket.data = { username, userId, gameId: null };

    // Pairing logic
    let game: Game | undefined;

    if (waitingQueue.length > 0) {
      const opponent = waitingQueue.shift()!;
      const gameId = generateGameId();

      // Randomly assign colors (but don't start yet)
      const isNewWhite = Math.random() < 0.5;
      const newPlayer = { socket, username, userId };
      const whitePlayer = isNewWhite ? newPlayer : opponent;
      const blackPlayer = isNewWhite ? opponent : newPlayer;

      game = {
        id: gameId,
        white: whitePlayer,
        black: blackPlayer,
        chess: new Chess(),
        phase: "bidding",
        whiteTime: 0, // To be set after bidding
        blackTime: 0, // To be set after bidding
        biddingTimerInterval: undefined,
        biddingTimeLeft: 10,
        drawOfferFrom: null,
      };

      activeGames.set(gameId, game);

      // Set gameId on both sockets
      whitePlayer.socket.data.gameId = gameId;
      blackPlayer.socket.data.gameId = gameId;

      console.log(
        `Game ${gameId} created in bidding phase: ${whitePlayer.userId} (white) vs ${blackPlayer.userId} (black)`
      );

      // Start bidding timer
      startBiddingTimer(game);

      // Notify both players of pairing and request bids
      const pairedData = { opponent: blackPlayer.userId };
      whitePlayer.socket.emit("paired", pairedData);
      const pairedDataBlack = { opponent: whitePlayer.userId };
      blackPlayer.socket.emit("paired", pairedDataBlack);
    } else {
      // Add to waiting queue
      waitingQueue.push({ socket, username, userId });
      console.log(`${userId} added to waiting queue`);
      socket.emit("waiting");

      // Send notifications for chess match created event
      sendNotification("chess_match_created").catch(console.error);
    }

    // Handle bid
    socket.on("bid", (data: { time: number }) => {
      const gameId = socket.data.gameId;
      if (!gameId || !activeGames.has(gameId)) {
        socket.emit("error", { message: "No active game" });
        return;
      }

      const game = activeGames.get(gameId)!;
      if (game.phase !== "bidding") {
        socket.emit("error", { message: "Bidding phase is over" });
        return;
      }

      const bid = Math.max(MIN_BID, Math.floor(data.time)); // Sanitize bid, enforce min
      if (isNaN(bid) || bid < MIN_BID) {
        socket.emit("error", {
          message: "Invalid bid, must be at least 60 seconds",
        });
        return;
      }

      const isWhite = socket.id === game.white.socket.id;
      (isWhite ? game.white : game.black).bid = bid;

      console.log(`${userId} bid ${bid} seconds`);

      // Check if both have bid
      if (game.white.bid && game.black.bid) {
        // Stop bidding timer since both have bid
        stopBiddingTimer(game);

        const selectedTime = Math.max(
          MIN_BID,
          Math.min(game.white.bid, game.black.bid)
        );
        game.whiteTime = selectedTime;
        game.blackTime = selectedTime;
        game.phase = "playing";

        const fen = game.chess.fen();
        const startDataWhite = {
          fen,
          your_color: "white",
          opponent: game.black.userId,
          time: selectedTime,
          whiteTime: game.whiteTime,
          blackTime: game.blackTime,
        };
        game.white.socket.emit("start", startDataWhite);

        const startDataBlack = {
          fen,
          your_color: "black",
          opponent: game.white.userId,
          time: selectedTime,
          whiteTime: game.whiteTime,
          blackTime: game.blackTime,
        };
        game.black.socket.emit("start", startDataBlack);

        console.log(
          `Game ${gameId} started with time ${selectedTime} seconds per player`
        );

        // Start white's timer
        startTimer(game);
      }
    });

    // Handle resign
    socket.on("resign", () => {
      const gameId = socket.data.gameId;
      if (!gameId || !activeGames.has(gameId)) {
        socket.emit("error", { message: "No active game" });
        return;
      }

      const game = activeGames.get(gameId)!;
      if (game.phase !== "playing") {
        socket.emit("error", { message: "Game not in playing phase" });
        return;
      }

      const isWhite = socket.id === game.white.socket.id;
      const winnerColor = isWhite ? "black" : "white";
      endGame(game, winnerColor, "resignation");
    });

    // Handle offer draw
    socket.on("offer_draw", () => {
      const gameId = socket.data.gameId;
      if (!gameId || !activeGames.has(gameId)) {
        socket.emit("error", { message: "No active game" });
        return;
      }

      const game = activeGames.get(gameId)!;
      if (game.phase !== "playing") {
        socket.emit("error", { message: "Game not in playing phase" });
        return;
      }

      const isWhite = socket.id === game.white.socket.id;
      const playerColor = isWhite ? "white" : "black";
      const opponentSocket = isWhite ? game.black.socket : game.white.socket;

      if (game.drawOfferFrom === playerColor) {
        socket.emit("error", {
          message: "You already have a pending draw offer",
        });
        return;
      }

      game.drawOfferFrom = playerColor;
      opponentSocket.emit("draw_offered", { from: playerColor });
      socket.emit("draw_offer_sent");
    });

    // Handle accept draw
    socket.on("accept_draw", () => {
      const gameId = socket.data.gameId;
      if (!gameId || !activeGames.has(gameId)) {
        socket.emit("error", { message: "No active game" });
        return;
      }

      const game = activeGames.get(gameId)!;
      if (game.phase !== "playing" || !game.drawOfferFrom) {
        socket.emit("error", { message: "No pending draw offer" });
        return;
      }

      const isWhite = socket.id === game.white.socket.id;
      const playerColor = isWhite ? "white" : "black";

      if (game.drawOfferFrom === playerColor) {
        socket.emit("error", { message: "Cannot accept your own draw offer" });
        return;
      }

      endGame(game, null, "draw_agreed");
    });

    // Handle decline draw
    socket.on("decline_draw", () => {
      const gameId = socket.data.gameId;
      if (!gameId || !activeGames.has(gameId)) {
        socket.emit("error", { message: "No active game" });
        return;
      }

      const game = activeGames.get(gameId)!;
      if (game.phase !== "playing" || !game.drawOfferFrom) {
        socket.emit("error", { message: "No pending draw offer" });
        return;
      }

      const isWhite = socket.id === game.white.socket.id;
      const playerColor = isWhite ? "white" : "black";

      if (game.drawOfferFrom === playerColor) {
        socket.emit("error", { message: "Cannot decline your own draw offer" });
        return;
      }

      game.drawOfferFrom = null;
      const opponentSocket = isWhite ? game.black.socket : game.white.socket;
      opponentSocket.emit("draw_declined");
      socket.emit("draw_offer_cancelled");
    });

    // Handle move
    socket.on("move", (data: { move: any }) => {
      const gameId = socket.data.gameId;
      if (!gameId || !activeGames.has(gameId)) {
        socket.emit("error", { message: "No active game" });
        return;
      }

      const game = activeGames.get(gameId)!;
      if (game.phase !== "playing") {
        socket.emit("error", { message: "Game not in playing phase" });
        return;
      }

      const playerColor = socket.id === game.white.socket.id ? "w" : "b";
      if (game.chess.turn() !== playerColor) {
        socket.emit("error", { message: "Not your turn" });
        return;
      }

      // Stop timer before validating move (time already spent)
      stopTimer(game);

      try {
        const move = game.chess.move(data.move);
        if (!move) {
          throw new Error("Invalid move");
        }

        const fen = game.chess.fen();

        // Broadcast update
        game.white.socket.emit("update", { fen });
        game.black.socket.emit("update", { fen });

        // Restart timer for opponent
        startTimer(game);

        // Check game over
        if (game.chess.isGameOver()) {
          let winnerColor: "white" | "black" | null = null;
          let reason = "";
          if (game.chess.isCheckmate()) {
            winnerColor = playerColor === "w" ? "white" : "black";
            reason = "checkmate";
          } else if (game.chess.isDraw()) {
            reason = "draw"; // Includes stalemate, insufficient material, etc.
          } else {
            reason = "draw"; // Other conditions
          }
          endGame(game, winnerColor, reason);
        } else {
          // Clear any pending draw offer after a move
          game.drawOfferFrom = null;
        }
      } catch (error) {
        // Restart timer if move invalid
        startTimer(game);
        socket.emit("error", { message: "Invalid move" });
      }
    });

    socket.on("disconnect", (reason) => {
      console.log(`User disconnected: ${socket.id}, Reason: ${reason}`);
      const userId = socket.data.userId;

      // Remove from queue if waiting
      const queueIndex = waitingQueue.findIndex(
        (p) => p.socket.id === socket.id
      );
      if (queueIndex !== -1) {
        waitingQueue.splice(queueIndex, 1);
        console.log(`Removed from waiting queue: ${userId}`);
        return;
      }

      // Handle active game disconnect
      const gameId = socket.data.gameId;
      if (gameId && activeGames.has(gameId)) {
        const game = activeGames.get(gameId)!;
        const isWhite = socket.id === game.white.socket.id;
        const opponentPlayer = isWhite ? game.black : game.white;

        if (game.phase === "bidding") {
          // Stop bidding timer
          stopBiddingTimer(game);

          // Delete game if not started, put opponent back to queue
          if (opponentPlayer.socket.connected) {
            opponentPlayer.socket.emit("opponent_disconnected", {
              message: "Opponent disconnected during bidding",
            });
            opponentPlayer.socket.data.gameId = null;
            waitingQueue.push(opponentPlayer);
            console.log(
              `Opponent ${opponentPlayer.userId} added back to queue`
            );
          }
          activeGames.delete(gameId);
          console.log(
            `Game ${gameId} deleted due to disconnect in bidding phase`
          );
        } else {
          // Opponent wins if game started
          const winnerColor = isWhite ? "black" : "white";
          endGame(game, winnerColor, "opponent disconnected");
        }
      }
    });
  });
}

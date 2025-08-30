use futures_util::{SinkExt, StreamExt};

use poem::{
    Error, IntoResponse, handler,
    http::StatusCode,
    web::{
        Data, Path,
        websocket::{Message, WebSocket},
    },
};
use tokio::sync::mpsc::Sender;
use tokio::sync::{RwLock, mpsc};

use std::collections::HashMap;
use std::sync::Arc;

mod common {
    include!("../common.rs");
}
use common::ServerKey;
use common::verify_token;

pub struct ChessApi {}

// Define a struct for Game
#[derive(Clone)] // Optional, but useful if you need to clone games
pub struct Game {
    player_white: String,
    player_black: String,
    board_fen: String, // FEN string representing the board position
    turn_white: bool,  // true if white's turn
}

#[handler]
pub async fn ws(
    Path((game_id, token)): Path<(String, String)>,
    server_key: Data<&ServerKey>,
    ws: WebSocket,
    clients: Data<&Arc<RwLock<HashMap<String, Sender<String>>>>>,
    games: Data<&Arc<RwLock<HashMap<String, Game>>>>, // New: shared games map
) -> Result<impl IntoResponse, Error> {
    // Verify token and get username
    let user = verify_token(server_key.0.clone(), token.clone())
        .await
        .ok_or_else(|| Error::from_status(StatusCode::UNAUTHORIZED))?;
    let username = user.username;

    // Validate game_id and user participation
    let games_guard = games.read().await;
    let is_valid = if let Some(game) = games_guard.get(&game_id) {
        game.player_white == username || game.player_black == username
    } else {
        false
    };
    if !is_valid {
        return Err(Error::from_status(StatusCode::BAD_REQUEST));
    }

    let clients = clients.clone();
    let games = games.clone(); // Clone for use in closure
    Ok(ws.on_upgrade(move |socket| async move {
        let (mut sink, mut stream) = socket.split();

        // Create a channel for this client
        let (tx, mut rx) = mpsc::channel::<String>(32);

        // Add client to the map
        clients.write().await.insert(username.clone(), tx);

        let clients_clone = clients.clone();
        let games_clone = games.clone();
        let username_clone = username.clone();
        let game_id_clone = game_id.clone();

        // Spawn writer task: receive from client's channel and send to sink
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if sink.send(Message::Text(msg)).await.is_err() {
                    break;
                }
            }
        });

        // Spawn reader task: read from stream, parse, process move, and broadcast updates
        tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                if let Message::Text(text) = msg {
                    // Parse JSON (assuming format: {"move": "e2e4"})
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(move_san) = parsed["move"].as_str() {
                            // Lock games for writing
                            let mut games_guard = games_clone.write().await;
                            if let Some(game) = games_guard.get_mut(&game_id_clone) {
                                // Determine if it's the sender's turn
                                let is_white = game.player_white == username_clone;
                                if (game.turn_white && is_white) || (!game.turn_white && !is_white)
                                {
                                    // Here: Validate the move using a chess library (e.g., rust-chess or similar crate)
                                    // Assume you have added a chess crate to Cargo.toml and imported it.
                                    // Example pseudocode:
                                    // let mut chess_board = ChessBoard::from_fen(&game.board_fen);
                                    // if chess_board.is_valid_move(move_san) {
                                    //     chess_board.apply_move(move_san);
                                    //     game.board_fen = chess_board.to_fen();
                                    //     game.turn_white = !game.turn_white;

                                    //     // Check if game is over (e.g., checkmate, stalemate, etc.)
                                    //     // if chess_board.is_checkmate() {
                                    //     //     let winner = if game.turn_white { game.player_black.clone() } else { game.player_white.clone() };
                                    //     //     // HERE: Add logic to update scores in your sqlx DB
                                    //     //     // e.g., sqlx::query!("UPDATE users SET score = score + 1 WHERE username = ?", winner).execute(&db_pool).await;
                                    //     //     // Also update loser's score if needed, or handle draws.
                                    //     //     // Optionally: remove the game from games_guard.remove(&game_id_clone);
                                    //     // }

                                    //     // Prepare update message (e.g., new FEN)
                                    //     let update_msg = format!("{{ \"type\": \"update\", \"fen\": \"{}\" }}", game.board_fen);

                                    //     // Drop games guard before sending
                                    //     drop(games_guard);

                                    //     // Send to both players
                                    //     let clients_guard = clients_clone.read().await;
                                    //     let games_read = games_clone.read().await;
                                    //     if let Some(game) = games_read.get(&game_id_clone) {
                                    //         if let Some(tx) = clients_guard.get(&game.player_white) {
                                    //             let _ = tx.send(update_msg.clone()).await;
                                    //         }
                                    //         if let Some(tx) = clients_guard.get(&game.player_black) {
                                    //             let _ = tx.send(update_msg.clone()).await;
                                    //         }
                                    //     }
                                    // } else {
                                    //     // Invalid move: send error back to sender
                                    //     // ...
                                    // }
                                } else {
                                    // Not your turn: send error back
                                    // ...
                                }
                            }
                        }
                    }
                }
            }

            // Cleanup on disconnect
            clients_clone.write().await.remove(&username_clone);
            // Optional: Check if both players disconnected and remove game
            // ...
        });
    }))
}

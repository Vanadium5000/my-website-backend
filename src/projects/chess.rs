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

use shakmaty::{
    CastlingMode, Chess, Color, EnPassantMode, Outcome, Position,
    fen::{Epd, Fen},
    san::San,
};

pub struct ChessApi {}

// Define a struct for Game
#[derive(Clone)] // Optional, but useful if you need to clone games
pub struct Game {
    player_white: String,
    player_black: String,
    board_fen: String,                // FEN string representing the board position
    turn_white: bool,                 // true if white's turn
    pos_counts: HashMap<String, u32>, // For tracking threefold repetition
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
                                if (game.turn_white && is_white) || (!game.turn_white && !is_white) {
                                    // Validate the move using shakmaty
                                    let fen = match game.board_fen.parse::<Fen>() {
                                        Ok(f) => f,
                                        Err(_) => {
                                            drop(games_guard);
                                            let err_msg = r#"{"type":"error","message":"Invalid board state"}"#.to_string();
                                            let cg = clients_clone.read().await;
                                            if let Some(tx) = cg.get(&username_clone) {
                                                let _ = tx.send(err_msg).await;
                                            }
                                            continue;
                                        }
                                    };
                                    let pos: Chess = match fen.into_position(CastlingMode::Standard) {
                                        Ok(p) => p,
                                        Err(_) => {
                                            drop(games_guard);
                                            let err_msg = r#"{"type":"error","message":"Invalid board state"}"#.to_string();
                                            let cg = clients_clone.read().await;
                                            if let Some(tx) = cg.get(&username_clone) {
                                                let _ = tx.send(err_msg).await;
                                            }
                                            continue;
                                        }
                                    };
                                    let san = match move_san.parse::<San>() {
                                        Ok(s) => s,
                                        Err(_) => {
                                            drop(games_guard);
                                            let err_msg = r#"{"type":"error","message":"Invalid SAN"}"#.to_string();
                                            let cg = clients_clone.read().await;
                                            if let Some(tx) = cg.get(&username_clone) {
                                                let _ = tx.send(err_msg).await;
                                            }
                                            continue;
                                        }
                                    };
                                    let mv = match san.to_move(&pos) {
                                        Ok(m) => m,
                                        Err(_) => {
                                            drop(games_guard);
                                            let err_msg = r#"{"type":"error","message":"Invalid move"}"#.to_string();
                                            let cg = clients_clone.read().await;
                                            if let Some(tx) = cg.get(&username_clone) {
                                                let _ = tx.send(err_msg).await;
                                            }
                                            continue;
                                        }
                                    };
                                    let new_pos = match pos.play(mv) {
                                        Ok(np) => np,
                                        Err(_) => {
                                            drop(games_guard);
                                            let err_msg = r#"{"type":"error","message":"Invalid move"}"#.to_string();
                                            let cg = clients_clone.read().await;
                                            if let Some(tx) = cg.get(&username_clone) {
                                                let _ = tx.send(err_msg).await;
                                            }
                                            continue;
                                        }
                                    };

                                    // Update game state
                                    game.board_fen = new_pos.board().board_fen().to_string();
                                    game.turn_white = !game.turn_white;

                                    // Check if game is over
                                    let mut game_over = false;
                                      let mut update_msg = format!(r#"{{"type":"update","fen":"{}"}}"#, game.board_fen);

                                                      let mut is_draw = false;
 match new_pos.outcome() {
    Outcome::Known(variant) => {
        game_over = true;
        match variant {
            shakmaty::KnownOutcome::Draw => {
                is_draw = true;
            }
            shakmaty::KnownOutcome::Decisive { winner } => {
                let winner_name = if winner == Color::White {
                    game.player_white.clone()
                } else {
                    game.player_black.clone()
                };
                update_msg = format!(r#"{{"type":"win","winner":"{}"}}"#, winner_name);
                // HERE: Add logic to update scores in your sqlx DB
                // e.g., sqlx::query!("UPDATE users SET score = score + 1 WHERE username = ?", winner_name).execute(&db_pool).await;
            }
        }
    }
    Outcome::Unknown => {
        // Check for fifty-move rule
        if new_pos.halfmoves() >= 100 {
            is_draw = true;
        } else {
            // Check for threefold repetition
            let epd_str = Epd::from_position(&new_pos, EnPassantMode::Legal).to_string();
            let count = game.pos_counts.entry(epd_str.clone()).or_insert(0);
            *count += 1;
            if *count >= 3 {
                is_draw = true;
            }
        }
    }
}

                                    if is_draw {
                                        game_over = true;
                                        update_msg = r#"{"type":"draw"}"#.to_string();
                                        // HERE: Add logic to handle draws in your sqlx DB if needed
                                        // e.g., update scores for both players
                                    }

                                    // Drop games guard before sending
                                    drop(games_guard);

                                    // Send to both players
                                    let clients_guard = clients_clone.read().await;
                                    let games_read = games_clone.read().await;
                                    if let Some(game) = games_read.get(&game_id_clone) {
                                        if let Some(tx) = clients_guard.get(&game.player_white) {
                                            let _ = tx.send(update_msg.clone()).await;
                                        }
                                        if let Some(tx) = clients_guard.get(&game.player_black) {
                                            let _ = tx.send(update_msg.clone()).await;
                                        }
                                    }

                                    // If game over, remove the game
                                    if game_over {
                                        let mut games_write = games_clone.write().await;
                                        games_write.remove(&game_id_clone);
                                    }
                                } else {
                                    // Not your turn: send error back
                                    drop(games_guard);
                                    let err_msg = r#"{"type":"error","message":"Not your turn"}"#.to_string();
                                    let cg = clients_clone.read().await;
                                    if let Some(tx) = cg.get(&username_clone) {
                                        let _ = tx.send(err_msg).await;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Cleanup on disconnect
            clients_clone.write().await.remove(&username_clone);
            // Handle disconnect: award win to opponent if game still exists
            let mut games_guard = games_clone.write().await;
            if let Some(game) = games_guard.get(&game_id_clone) {
                let other = if game.player_white == username_clone {
                    game.player_black.clone()
                } else {
                    game.player_white.clone()
                };
                drop(games_guard);
                let win_msg = r#"{"type":"win","reason":"opponent disconnected"}"#.to_string();
                let clients_g = clients_clone.read().await;
                if let Some(tx) = clients_g.get(&other) {
                    let _ = tx.send(win_msg).await;
                    // HERE: Add logic to update scores in your sqlx DB for win by disconnect
                    // e.g., sqlx::query!("UPDATE users SET score = score + 1 WHERE username = ?", other).execute(&db_pool).await;
                }
                // Remove the game
                let mut games_g = games_clone.write().await;
                games_g.remove(&game_id_clone);
            }
        });
    }))
}
